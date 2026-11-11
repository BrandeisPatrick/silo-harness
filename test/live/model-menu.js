// Live check of the model menu under the composer (the model chip), idle and while a run goes on, with a long model
// id of the shape a gateway gives ("@gateway/vendor.model"): it opens on a real click, stays open, lists the models,
// sits inside the window next to the chip, and a choice is applied. A provider listing dozens of models used to get a
// menu taller than the room above the chip, which flipped below it, off the bottom of the window, where nothing in it
// could be reached: now it is capped to the room above and scrolls. A slow list shows "Loading models…" first and
// fills in; a list that fails keeps the configured model.
// Run: npm run build && node test/live/model-menu.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const { check, done } = checker();
const LONG = '@acme-gateway/vendorco.large-model-name-v5';
const MANY = Array.from({ length: 60 }, (_, i) => `@acme-gateway/vendorco.model-${String(i).padStart(2, '0')}-preview`);

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const app = await launch({ mode: 'bypass', mock: true });
  const state = app.mock.state;
  const pill = () => app.evaluate(`(() => { const r = document.querySelector('#model-btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, left: r.left, text: document.querySelector('#model-btn').innerText.trim() }; })()`);
  const menu = () =>
    app.evaluate(`(() => {
      const m = document.querySelector('.popover');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      const items = [...m.querySelectorAll('.pop-item')].map((b) => b.querySelector('.pop-title').textContent);
      return { top: r.top, bottom: r.bottom, left: r.left, vh: innerHeight, items, note: m.querySelector('.pop-note')?.textContent ?? null, scrolls: m.scrollHeight > m.clientHeight + 1, expanded: document.querySelector('#model-btn').getAttribute('aria-expanded') };
    })()`);
  async function realClick(x, y) {
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await app.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
    await app.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  const closeMenu = async () => {
    await app.key('Escape');
    await app.waitFor(`!document.querySelector('.popover')`, 3000, 'the menu to close').catch(() => {});
  };
  /** Opens the menu with a real click on the chip and returns what it looks like once the list is in */
  async function open(label, until = `(() => { const m = document.querySelector('.popover'); return m && !/Loading/.test(m.textContent); })()`) {
    const p = await pill();
    await realClick(p.x, p.y);
    await app.waitFor(until, 15_000, `${label}: the list`).catch(() => {});
    await sleep(300);
    const m = await menu();
    await sleep(1200);
    const still = await menu();
    return { p, m, stillOpen: Boolean(still) };
  }
  /** Checks a menu: open, inside the window, next to the chip, listing what it should */
  function checkMenu(label, r, want) {
    check(`${label}: opens on a click and stays open`, r.m && r.stillOpen && r.m.expanded === 'true', r.m);
    if (!r.m) return;
    check(`${label}: the whole menu is inside the window, just above the chip`, r.m.top >= 0 && r.m.bottom <= r.m.vh && r.m.bottom <= r.p.top && r.p.top - r.m.bottom < 12, { top: r.m.top, bottom: r.m.bottom, vh: r.m.vh, chip: r.p.top });
    check(`${label}: it lists the models (${want} of them)`, r.m.items.filter((t) => t.startsWith('@acme-gateway/')).length === want, r.m.items.length);
  }

  try {
    // A gateway's long model id, and the service lists sixty more
    state.models = [LONG, ...MANY];
    await app.evaluate(`(async () => { const c = await oc.getConfig(); await oc.setConfig({ ...c, portkey: { ...c.portkey, model: ${JSON.stringify(LONG)} } }); })()`);
    await app.waitFor(`document.querySelector('#model-btn').innerText.trim() === ${JSON.stringify(LONG)}`, 5000, 'the chip to show the long id');

    // ---------- Idle ----------
    let r = await open('idle');
    checkMenu('idle, 61 models', r, 61);
    check('idle: a list taller than the room scrolls inside the menu', r.m?.scrolls === true, r.m);
    await app.screenshot(path.join(shots, 'model-menu-idle.png'));
    await closeMenu();

    // ---------- While a run goes on ----------
    state.replies.push({ content: 'A slow answer.', delayMs: 25_000 });
    await app.send('Take your time');
    await app.waitFor(`!document.querySelector('#status-line').hidden`, 10_000, 'the run');
    await sleep(1200);
    r = await open('running');
    checkMenu('running, 61 models', r, 61);
    check('running: the checked model is the one in use, scrolled into view', await app.evaluate(`(() => { const m = document.querySelector('.popover'); const b = m?.querySelector('.pop-item.checked'); if (!b) return false; const a = b.getBoundingClientRect(), mr = m.getBoundingClientRect(); return b.textContent.includes(${JSON.stringify(LONG)}) && a.top >= mr.top - 1 && a.bottom <= mr.bottom + 1; })()`));
    await app.screenshot(path.join(shots, 'model-menu-running.png'));
    // A choice from far down the list is applied, during the run
    const target = MANY[59];
    await app.evaluate(`(() => { const b = [...document.querySelectorAll('.popover .pop-item')].find((x) => x.querySelector('.pop-title').textContent === ${JSON.stringify(target)}); b.scrollIntoView({ block: 'nearest' }); })()`);
    await sleep(200);
    const at = await app.evaluate(`(() => { const b = [...document.querySelectorAll('.popover .pop-item')].find((x) => x.querySelector('.pop-title').textContent === ${JSON.stringify(target)}); const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2, inView: q.top >= 0 && q.bottom <= innerHeight }; })()`);
    check('running: the last model in the list can be scrolled to, inside the window', at.inView, at);
    await realClick(at.x, at.y);
    await app.waitFor(`document.querySelector('#model-btn').innerText.trim() === ${JSON.stringify(target)}`, 5000, 'the choice').catch(() => {});
    const chosen = await app.evaluate(`oc.getConfig().then((c) => c.portkey.model)`);
    check('running: the choice is applied (the chip and the config)', chosen === target && (await pill()).text === target, { chosen, chip: (await pill()).text });

    // A slow list during the run: "Loading models…" first, then the list
    state.modelsDelayMs = 2500;
    const p = await pill();
    await realClick(p.x, p.y);
    await sleep(500);
    const loading = await menu();
    check('running, slow list: the menu is open at once with "Loading models…"', loading && /Loading models/.test(loading.note ?? '') && loading.bottom <= loading.vh, loading);
    await app.waitFor(`(() => { const m = document.querySelector('.popover'); return m && m.querySelectorAll('.pop-item').length > 10; })()`, 10_000, 'the slow list').catch(() => {});
    const filled = await menu();
    check('running, slow list: it fills in and stays inside the window', filled && filled.items.filter((t) => t.startsWith('@acme-gateway/')).length === 61 && filled.top >= 0 && filled.bottom <= filled.vh, filled && { n: filled.items.length, top: filled.top, bottom: filled.bottom });
    await closeMenu();
    state.modelsDelayMs = 0;

    // A list that fails: the configured model is still there to pick
    state.modelsStatus = 500;
    r = await open('failing', `Boolean(document.querySelector('.popover'))`);
    await sleep(800);
    const failed = await menu();
    check('running, failing list: the menu opens and shows the model in use', failed && failed.items.includes(target) && failed.bottom <= failed.vh, failed);
    await closeMenu();
    state.modelsStatus = 0;

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
