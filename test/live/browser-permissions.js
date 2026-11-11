// Live check of the permission bar in the real app (hidden, a throwaway profile, the mock model) on the fixture site:
// a camera request from a page shows the bar under the URL bar with the site and both devices, Chrome's three answers
// in that order, and takes its height out of the view's slot; Don't allow rejects the page's promise with
// NotAllowedError and is saved; Allow every time (notifications) is saved and a second launch on the same profile
// does not ask; a request from a tab in the background waits until that tab is in front, Allow this time holds for
// that tab until it leaves the site, and Escape on the bar answers Don't allow; the app's own window keeps its
// permissions. Chromium's stand-in camera and microphone (--use-fake-device-for-media-stream) are used.
// Run: npm run build && node test/live/browser-permissions.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');
const { startSite } = require('./support/site.js');

const { check, done } = checker();

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  const otherHost = site.other.replace(/^https?:\/\//, '');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-browser-permissions-'));
  const args = ['--use-fake-device-for-media-stream'];
  // A larger page than the default, so the pane can be made wide enough for the bar's one row
  let app = await launch({ profile, mode: 'bypass', mock: true, args, size: { width: 1800, height: 1000 } });
  const file = path.join(profile, 'browser', 'permissions.json');
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const dbg = () => app.evaluate('window.__oc_debug.mods.browser()');
  const bars = async () => (await dbg()).safety.bars.filter((b) => b.kind === 'permission');
  const waitBar = (re, what) => app.waitFor(`window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'permission' && ${re}.test(b.text))`, 10_000, what);
  const waitNoBar = (what) => app.waitFor(`!window.__oc_debug.mods.browser().safety.bars.some((b) => b.kind === 'permission')`, 10_000, what);
  const answer = (label) =>
    app.evaluate(`(() => { const b = [...document.querySelectorAll('#browser-bars .browser-ask.permission button')].find((x) => x.textContent === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  const go = (url) => app.evaluate(`oc.rpc('browser.go', ${JSON.stringify(url)})`);

  try {
    // ---------- The bar, Don't allow ----------
    let r = await app.callTool('browser_navigate', { url: `${site.base}/camera.html` });
    check('setup: the camera page opens', /Camera/.test(r ?? ''), r);
    let ws = await app.pageTarget(`${site.base}/camera.html`);
    await sleep(300);
    const before = (await dbg()).bounds;
    await evalAt(ws, `(window.__cam = requestCamera(), 'asked')`);
    await waitBar(/camera and microphone/, 'the permission bar');
    let b = (await bars())[0];
    check('a camera request from the page shows the bar with the site and both devices', b && b.text === `${site.host} wants to use your camera and microphone`, b);
    check("… with Allow this time, Allow every time and Don't allow, in that order", b && JSON.stringify(b.buttons) === JSON.stringify(['Allow this time', 'Allow every time', "Don't allow"]), b && b.buttons);
    const look = (w) => app.evaluate(`(async () => {
      document.getElementById('side-pane').style.setProperty('--browser-w', '${w}px');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const bar = document.querySelector('#browser-bars .browser-ask.permission');
      const s = getComputedStyle(bar);
      const css = (sel) => getComputedStyle(bar.querySelector(sel));
      const btns = [...bar.querySelectorAll('button')];
      const rect = (el) => el.getBoundingClientRect();
      return { w: Math.round(rect(bar).width), h: Math.round(rect(bar).height), bb: s.borderBottomWidth, bg: s.backgroundColor, page: getComputedStyle(document.body).backgroundColor, fs: css('.browser-ask-text').fontSize, prim: css('.browser-ask-btn.primary').backgroundColor, ghost: css('.browser-ask-btn:not(.primary)').backgroundColor, last: btns[btns.length - 1].classList.contains('primary'), barTop: Math.round(rect(bar).top), urlBottom: Math.round(rect(document.querySelector('.browser-bar')).bottom), textBottom: Math.round(rect(bar.querySelector('.browser-ask-text')).bottom), btnTop: Math.round(rect(btns[0]).top), slotTop: Math.round(rect(document.getElementById('browser-view')).top) };
    })()`);
    const wide = await look(880);
    check('in a wide pane the bar is one 44 px row on the page colour with a hairline, its sentence 14 px, right under the URL bar', wide.h === 44 && wide.bb === '1px' && wide.bg === wide.page && wide.fs === '14px' && wide.barTop === wide.urlBottom && wide.slotTop === wide.barTop + 44, wide);
    check("… Don't allow is the grey button, at the right; the others are ghosts", wide.last && wide.prim !== 'rgba(0, 0, 0, 0)' && wide.ghost === 'rgba(0, 0, 0, 0)', wide);
    await app.screenshotOf(path.join(shots, 'permission-bar-wide.png'), '#side-pane');
    await app.evaluate(`document.getElementById('side-pane').style.removeProperty('--browser-w')`);
    await sleep(200);
    const narrow = await look(420);
    await app.evaluate(`document.getElementById('side-pane').style.removeProperty('--browser-w')`);
    check('in a narrow pane the answers move under the sentence', narrow.btnTop >= narrow.textBottom && narrow.h > 44, narrow);
    await app.waitFor(`window.__oc_debug.mods.browser().bounds.height < ${before.height}`, 5000, 'the view slot to shrink').catch(() => undefined);
    await sleep(200);
    const after = (await dbg()).bounds;
    const barH = (await bars())[0].height;
    check("the view's slot gives the bar its height: the page is not covered", Math.round(after.y - before.y) === Math.round(barH) && Math.round(before.height - after.height) === Math.round(barH), { before, after, barH });
    check('the bar is the window\'s, not the page\'s', !(await evalAt(ws, 'document.body.innerText')).includes('wants to'));
    await app.screenshotOf(path.join(shots, 'permission-bar-narrow.png'), '#side-pane');
    check("Don't allow answers it", await answer("Don't allow"));
    const cam = await evalAt(ws, 'window.__cam');
    check("… the page's promise rejects with NotAllowedError", cam === 'NotAllowedError', cam);
    await waitNoBar('the bar to go');
    await sleep(300);
    check('… the bar goes and the slot gets its height back', (await bars()).length === 0 && Math.round((await dbg()).bounds.height) === Math.round(before.height), (await dbg()).bounds);
    check('… saved for the site, per capability', saved()[site.base]?.camera === 'deny' && saved()[site.base]?.microphone === 'deny', saved());
    const cam2 = await evalAt(ws, 'requestCamera()');
    await sleep(200);
    check('the next request is refused without a bar', cam2 === 'NotAllowedError' && (await bars()).length === 0, cam2);

    // ---------- Allow every time ----------
    await evalAt(ws, `(window.__n = Notification.requestPermission(), 'asked')`);
    await waitBar(/show notifications/, 'the notifications bar');
    check('notifications ask on the bar', (await bars())[0]?.text === `${site.host} wants to show notifications`);
    check('Allow every time answers it', await answer('Allow every time'));
    check('… the page gets them', (await evalAt(ws, 'window.__n')) === 'granted');
    check('… saved', saved()[site.base]?.notifications === 'allow', saved());
    const n2 = await evalAt(ws, 'Promise.all([Notification.requestPermission(), Notification.permission])');
    check('… no second question, and the page sees them granted', JSON.stringify(n2) === '["granted","granted"]' && (await bars()).length === 0, n2);

    // ---------- A tab in the background waits; Allow this time; Escape ----------
    const firstTab = (await dbg()).activeId;
    await app.evaluate(`oc.rpc('browser.newTab', ${JSON.stringify(`${site.other}/camera.html`)}, { background: true })`);
    const ws2 = await app.pageTarget(`${site.other}/camera.html`);
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.length === 2 && window.__oc_debug.mods.browser().tabs[1].title === 'Camera'`, 10_000, 'the background tab to load');
    const secondTab = (await dbg()).tabs[1].id;
    await evalAt(ws2, `(window.__cam = requestCamera(), 'asked')`);
    await app.waitFor(`window.__oc_debug.mods.browser().safety.requests.length === 1`, 10_000, 'the request to reach the window');
    await sleep(300);
    let d = await dbg();
    check('a request from a tab in the background waits: no bar on the tab in front', d.activeId === firstTab && d.safety.bars.length === 0 && d.safety.requests[0].tabId === secondTab, d.safety);
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(secondTab)})`);
    await waitBar(/camera and microphone/, 'the bar on the background tab once it is in front');
    check('… and shows once its tab is in front', (await bars())[0]?.text === `${otherHost} wants to use your camera and microphone`, await bars());
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(firstTab)})`);
    await waitNoBar('the bar to stay with its tab');
    check('… it stays with its tab when another comes to the front', (await bars()).length === 0 && (await dbg()).safety.requests.length === 1);
    await app.evaluate(`oc.rpc('browser.activateTab', ${JSON.stringify(secondTab)})`);
    await waitBar(/camera and microphone/, 'the bar again');
    check('Allow this time answers it', await answer('Allow this time'));
    check('… the page gets the camera', (await evalAt(ws2, 'window.__cam')) === 'granted');
    check('… nothing is saved for that site', !saved()[site.other], saved());
    check('… and it holds for the tab: the page reads it granted', (await evalAt(ws2, `navigator.permissions.query({ name: 'camera' }).then((s) => s.state)`)) === 'granted');
    await go(`${site.base}/landing.html`);
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.find((t) => t.id === ${JSON.stringify(secondTab)})?.title === 'Landing'`, 10_000, 'the tab to leave the site');
    await go(`${site.other}/camera.html`);
    const ws3 = await app.pageTarget(`${site.other}/camera.html`);
    await app.waitFor(`window.__oc_debug.mods.browser().tabs.find((t) => t.id === ${JSON.stringify(secondTab)})?.title === 'Camera'`, 10_000, 'the tab to come back');
    const state = await evalAt(ws3, `navigator.permissions.query({ name: 'camera' }).then((s) => s.state)`);
    check('this time ends when the tab leaves the site, even when it comes back', state !== 'granted', state);
    await evalAt(ws3, `(window.__cam = requestCamera(), 'asked')`);
    await waitBar(/camera and microphone/, 'the bar asking again');
    check('… so the next request asks again', (await bars()).length === 1);
    await app.evaluate(`document.querySelector('#browser-bars .browser-ask.permission button').focus()`);
    await app.key('Escape');
    check("Escape on the bar answers Don't allow", (await evalAt(ws3, 'window.__cam')) === 'NotAllowedError' && saved()[site.other]?.camera === 'deny', saved()[site.other]);

    // ---------- The app's own window ----------
    const own = await app.evaluate(`(async () => ({ notif: await Notification.requestPermission(), current: Notification.permission, camera: (await navigator.permissions.query({ name: 'camera' })).state }))()`);
    check("the app's own page keeps its permissions, without a bar", own && own.notif === 'granted' && own.current === 'granted' && own.camera === 'granted' && (await bars()).length === 0, own);
    check('nothing was answered behind the user\'s back: the file holds only their answers', JSON.stringify(Object.keys(saved()).sort()) === JSON.stringify([site.base, site.other].sort()), saved());

    // ---------- A second launch on the same profile ----------
    await app.close();
    app = await app.relaunch();
    r = await app.callTool('browser_navigate', { url: `${site.base}/camera.html` });
    ws = await app.pageTarget(`${site.base}/camera.html`);
    const again = await evalAt(ws, 'Promise.all([Notification.permission, Notification.requestPermission(), requestCamera()])');
    await sleep(300);
    check('a second launch does not ask: notifications still granted, the camera still refused', JSON.stringify(again) === JSON.stringify(['granted', 'granted', 'NotAllowedError']) && (await bars()).length === 0, again);

    // ---------- Settings → Browser ----------
    await app.evaluate(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-browser').click(); })()`);
    await app.waitFor(`document.querySelector('#sp-sec-browser.current [data-permission]')`, 10_000, 'Settings → Browser with its permissions');
    const nav = await app.evaluate(`[...document.querySelectorAll('.sp-nav-item')].map((b) => b.dataset.section)`);
    check('Settings has a Browser section after Permissions', nav.indexOf('browser') === nav.indexOf('permissions') + 1, nav);
    const sec = await app.evaluate(`(() => {
      const q = (s) => document.querySelector('#sp-sec-browser ' + s);
      const rows = [...document.querySelectorAll('#sp-sec-browser [data-permission]')].map((r) => ({ key: r.dataset.permission, title: r.querySelector('.sp-row-name').textContent, desc: r.querySelector('.sp-row-desc').textContent }));
      return {
        keep: q('#sp-row-browser-keepCookies input.switch')?.checked,
        links: q('#sp-row-browser-openChatLinksInPane input.switch')?.checked,
        clear: !!q('#sp-row-browser-clearData button'),
        dir: q('#sp-row-browser-downloadsDir .sp-row-desc')?.textContent,
        builtIn: q('.sp-disclosure')?.textContent,
        exempt: q('#sp-row-browser-exempt-builtin .sp-row-desc')?.textContent,
        rows,
      };
    })()`);
    const builtIns = await app.evaluate(`oc.rpc('browser.builtInLists')`);
    check('… with Keep cookies (on), Clear browsing data, the downloads folder and chat links (off)', sec.keep === true && sec.links === false && sec.clear && /Downloads/.test(sec.dir ?? ''), sec);
    check('… the built-in sites that always ask, folded, and the built-in exempt hosts', sec.builtIn === `Built-in (${builtIns.sensitive.length})` && builtIns.sensitive.length > 40 && /^localhost, 127\.0\.0\.1, \[::1\], \*\.localhost, \*\.test/.test(sec.exempt ?? ''), sec);
    check('… and the saved answers, by site', sec.rows.length === 5 && sec.rows.some((r) => r.title === site.host && r.desc === 'Notifications: Allowed') && sec.rows.some((r) => r.title === otherHost && r.desc === 'Camera: Blocked'), sec.rows);
    await app.evaluate(`[...document.querySelectorAll('#sp-sec-browser [data-permission]')].find((r) => r.dataset.permission === ${JSON.stringify(`${site.base} notifications`)}).querySelector('button').click()`);
    await app.waitFor(`document.querySelectorAll('#sp-sec-browser [data-permission]').length === 4`, 5000, 'the row to go');
    check('Reset forgets one answer, in the file too', saved()[site.base] && !('notifications' in saved()[site.base]) && saved()[site.base].camera === 'deny', saved());
    const addSite = async (text) => {
      await app.fill('#sp-row-browser-alwaysAllowed-add input', text);
      await app.click('#sp-row-browser-alwaysAllowed-add button');
      await sleep(300);
    };
    await addSite('not a site');
    check('a site that is not one is refused under the field', /Enter a site like/.test((await app.text('#sp-row-browser-alwaysAllowed-add .sp-problem')) ?? ''));
    await addSite('https://Example.com/some/page');
    let cfg = await app.evaluate('oc.getConfig()');
    check('Add puts the site in the list the agent may always use, as its origin (an approval covers one scheme)', JSON.stringify(cfg.browser.alwaysAllowed) === '["https://example.com"]' && (await app.evaluate(`[...document.querySelectorAll('#sp-sec-browser [id^="sp-row-browser-alwaysAllowed-0"] .sp-row-name')].map((e) => e.textContent).join()`)) === 'https://example.com', cfg.browser);
    // A site card's "Always allow" while Settings is open: the main process adds it, the list follows.
    await app.evaluate(`oc.rpc('browser.editList', 'alwaysAllowed', 'add', 'card.example')`);
    await app.waitFor(`document.querySelectorAll('#sp-sec-browser [id^="sp-row-browser-alwaysAllowed-"]:not([id$="-add"])').length === 2`, 5000, 'the list to follow');
    await app.click('#sp-sec-browser [id^="sp-row-browser-alwaysAllowed-0"] button');
    await app.waitFor(`(async () => JSON.stringify((await oc.getConfig()).browser.alwaysAllowed) === '["card.example"]')()`, 5000, 'Remove to save');
    check('Remove takes one entry out, keeping one added meanwhile', true);
    await app.evaluate(`document.querySelector('#sp-row-browser-keepCookies input.switch').click()`);
    await sleep(300);
    cfg = await app.evaluate('oc.getConfig()');
    check('Keep cookies switches off in the config', cfg.browser.keepCookies === false, cfg.browser);
    await app.screenshotOf(path.join(shots, 'settings-browser.png'), '#settings');
  } finally {
    await app.close();
    site.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
