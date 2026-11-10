// Live checks of the mod host (src/renderer/mods-host.ts) in the real window, through the rig: the bundled mods in
// the rail, the layout and its persistence, hot reload of a user mod, every seat, injected styles, isolation, the
// native browser view's alignment, and (with an API key) a real run and the agent writing a mod.
// Run: npm run build && node test/live/mods.js [phase…]   phases: bundled layout narrow reload seats isolation agent
// Screenshots go to $SHOTS (default: a temp folder).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const only = new Set(process.argv.slice(2));
const want = (phase) => !only.size || only.has(phase);
const { check, done } = checker();
const shot = (app, name) => app.screenshot(path.join(SHOTS, `${name}.png`));

const dbg = (app, expr) => app.evaluate(`window.__oc_debug.mods.${expr}`);
const views = (app) => dbg(app, 'views()');
const view = async (app, key) => (await views(app)).find((v) => v.key === key);
const rpc = (app, method, ...args) => app.evaluate(`window.oc.rpc(${JSON.stringify(method)}, ...${JSON.stringify(args)})`);
const errors = async (app) => (await dbg(app, 'log()')).filter((e) => e.kind === 'error');

/** The native browser view's bounds as the main process holds them (through its inspector): 0 × 0 when hidden. */
async function browserViewSize(app) {
  const list = await (await fetch(`http://127.0.0.1:${app.inspectPort}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const expression = `(() => { const { BrowserWindow } = process.mainModule.require('electron'); const w = BrowserWindow.getAllWindows()[0]; const b = w.contentView.children[0].getBounds(); return [b.x, b.y, b.width, b.height]; })()`;
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result?.result?.value ?? null);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  ws.close();
  return res;
}

/** Runs an expression in the main process (through its inspector). */
async function mainEval(app, expression) {
  const list = await (await fetch(`http://127.0.0.1:${app.inspectPort}/json/list`)).json();
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result?.result?.value ?? null);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return res;
}

/**
 * A hidden window draws (and runs resize observers and animation frames) only when asked: draw a few frames after a
 * layout change, before measuring or capturing it.
 */
async function paint(app) {
  await mainEval(app, `(async () => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows()[0]; for (let i = 0; i < 3; i++) { w.webContents.invalidate(); await w.webContents.capturePage(); } return true; })()`);
  await sleep(250);
}

/** Evaluates in a mod frame (an out-of-process iframe target) whose URL contains `part`; null when it cannot be reached. */
async function frameEval(app, part, expression) {
  const list = await (await fetch(`http://127.0.0.1:${app.port}/json/list`)).json();
  const t = list.find((x) => x.type === 'iframe' && x.url.includes(part));
  if (!t || !t.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const res = await new Promise((resolve) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id === 1) resolve(m.result?.result?.value ?? null);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    setTimeout(() => resolve(null), 4000);
  });
  ws.close();
  return res;
}

/** In a mod frame: how far the page overflows its frame, scrollbars, and the controls that stick out of it. */
const FRAME_FIT = `(() => {
  const d = document.documentElement;
  const vw = d.clientWidth;
  const cut = [...document.querySelectorAll('button, input, select, .h-segmented, .h-switch')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5); }).map((e) => (e.textContent || e.className).trim().replace(/\\s+/g, ' '));
  return { width: vw, overflowX: d.scrollWidth - vw, overflowY: d.scrollHeight - d.clientHeight, scrollbars: (innerWidth - vw) + (innerHeight - d.clientHeight), cut };
})()`;

async function start(profile) {
  const inspectPort = 20000 + Math.floor(Math.random() * 20000);
  const app = await launch({ profile, mode: 'bypass', config: { theme: 'light' }, args: [`--inspect=${inspectPort}`] });
  app.inspectPort = inspectPort;
  return app;
}

/** The bounds sent for the native view match #browser-view's box, and the view's page has that size. */
async function checkAligned(app, label) {
  await sleep(350);
  const b = await dbg(app, 'browser()');
  const size = await browserViewSize(app);
  const e = b.element;
  const same = b.bounds && ['x', 'y', 'width', 'height'].every((k) => Math.abs(b.bounds[k] - e[k]) < 1);
  const placed = size && [e.x, e.y, e.width, e.height].every((v, i) => Math.abs(size[i] - v) <= 1);
  // What the window thinks is in front, for the failure message: an open dialog or another tab explains a hidden view.
  const state = await app.evaluate(`({ dialogs: [...document.querySelectorAll('dialog')].filter((d) => d.open).map((d) => d.id), shell: document.querySelector('.shell').className, tab: document.querySelector('.pane-tab.active')?.id, menu: Boolean(document.querySelector('.popover')) })`);
  check(`browser view covers #browser-view (${label})`, b.visible && same && placed, { sent: b.bounds, element: e, view: size, state, errors: app.console.filter((l) => /^\[(error|exception)\]/.test(l)).slice(-3) });
}

async function checkHidden(app, label) {
  await sleep(350);
  const size = await browserViewSize(app);
  check(`browser view hidden (${label})`, size && size[2] === 0 && size[3] === 0, { view: size });
}

/** Decodes an RGBA PNG (what the rig's screenshots are) to raw pixels. */
function pixels(file) {
  const zlib = require('node:zlib');
  const b = fs.readFileSync(file);
  let i = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = b.readUInt32BE(i + 8);
      h = b.readUInt32BE(i + 12);
    }
    if (type === 'IDAT') idat.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const d = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = w * bpp + 1;
  const out = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const ft = d[y * stride];
    for (let x = 0; x < w * bpp; x++) {
      const r = d[y * stride + 1 + x];
      const a = x >= bpp ? out[y * w * bpp + x - bpp] : 0;
      const up = y ? out[(y - 1) * w * bpp + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * w * bpp + x - bpp] : 0;
      let v = r;
      if (ft === 1) v = r + a;
      else if (ft === 2) v = r + up;
      else if (ft === 3) v = r + ((a + up) >> 1);
      else if (ft === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      out[y * w * bpp + x] = v & 255;
    }
  }
  return { w, h, out };
}

/** How many pixels differ between two screenshots of the same size. */
function pixelDiff(fileA, fileB) {
  const a = pixels(fileA);
  const b = pixels(fileB);
  if (a.w !== b.w || a.h !== b.h) return Infinity;
  let n = 0;
  for (let i = 0; i < a.out.length; i += 4) if (a.out[i] !== b.out[i] || a.out[i + 1] !== b.out[i + 1] || a.out[i + 2] !== b.out[i + 2]) n++;
  return n;
}

function writeMod(root, id, manifest, files) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ protocol: 1, id, version: '0.1.0', ...manifest }, null, 2));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const page = (body, script = '') => `<!doctype html>
<link rel="stylesheet" href="/@harness/harness.css">
${body}
<script src="/@harness/harness.js"></script>
<script>${script}</script>`;

const HELLO = (v) => page(`<div class="h-row"><span class="h-label">Hello</span><span class="h-value">v${v}</span></div>`, `harness.ready.then(() => harness.ui.setTitle('Hello v${v}'));`);

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-mods-profile-'));
  const userMods = path.join(profile, 'home-config', 'mods');
  let app = await start(profile);
  console.log(`model: ${app.live ? 'real API' : 'mock model (no key)'}; screenshots: ${SHOTS}`);
  try {
    // ---------- The bundled mods in the rail ----------
    const BUNDLED = ['environment', 'context', 'tasks', 'plan', 'outputs', 'sub-sessions', 'skills'];
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.hello).length >= 7`, 15_000, 'seven rail views to say hello');
    if (want('bundled')) {
      const vs = await views(app);
      for (const id of BUNDLED) {
        const v = vs.find((x) => x.key === `${id}/main`);
        check(`${id}: in the rail, said hello, has content`, v && v.seat === 'rail' && v.hello && !v.failed && v.height > 20, v && { hello: v.hello, height: v.height });
      }
      const order = vs.filter((v) => v.seat === 'rail').map((v) => v.key);
      const shown = await app.evaluate(`[...document.querySelectorAll('#mod-rail-sections .rail-section')].sort((a, b) => a.style.order - b.style.order).map((s) => s.dataset.view)`);
      check('sections ordered by order, then title', JSON.stringify(shown) === JSON.stringify(['environment/main', 'context/main', 'tasks/main', 'plan/main', 'outputs/main', 'sub-sessions/main', 'skills/main']), shown);
      check('no bridge call refused or failed (empty session)', (await errors(app)).length === 0, await errors(app));
      check('rail toggle shown and pressed', await app.evaluate(`!document.querySelector('#rail-toggle').hidden && document.querySelector('#rail-toggle').getAttribute('aria-pressed') === 'true'`));
      await checkAligned(app, 'rail open, default width');
      await shot(app, 'window-empty-light');
      await app.screenshotOf(path.join(SHOTS, 'topbar-light.png'), '.topbar-actions', 8);
      await app.screenshotOf(path.join(SHOTS, 'rail-light.png'), '#mod-rail', 0);

      // A real run with tools and the task list.
      await app.send(app.live ? 'Use update_tasks to make a three-step task list (read, change, test), mark the first one in progress, then run `ls` with bash, then mark all done. Keep replies short.' : 'Run ls');
      await app.waitFor(`Boolean(document.querySelector('.session-item.running')) || !document.querySelector('#status-line').hidden`, 20_000, 'the run to start').catch(() => {});
      await app.waitFor(`window.__oc_debug.mods.log().some((e) => e.kind === 'event' && e.method === 'tasks.changed')`, 60_000, 'a tasks.changed event').catch(() => {});
      await shot(app, 'window-midrun-light');
      await app.waitIdle(120_000, false);
      await sleep(1000);
      const log = await dbg(app, 'log()');
      const evs = new Set(log.filter((e) => e.kind === 'event').map((e) => e.method));
      check('run events reached subscribed views', evs.has('run.started') && evs.has('run.ended') && (!app.live || (evs.has('tasks.changed') && evs.has('outputs.changed'))), [...evs]);
      if (app.live) check('tasks.changed reached the Tasks view', log.some((e) => e.kind === 'event' && e.method === 'tasks.changed' && e.view === 'tasks/main'));
      check('no bridge call refused or failed (after a run)', (await errors(app)).length === 0, await errors(app));
      await shot(app, 'window-after-run-light');
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'dark'; await window.oc.setConfig(c); })()`);
      await app.waitFor(`document.documentElement.dataset.theme === 'dark'`, 5000).catch(() => {});
      await app.evaluate(`document.documentElement.dataset.theme = 'dark'`);
      await sleep(800);
      check('theme.changed reached the bundled views', (await dbg(app, 'log()')).some((e) => e.kind === 'event' && e.method === 'theme.changed' && e.view === 'context/main'));
      await shot(app, 'window-after-run-dark');
      await app.screenshotOf(path.join(SHOTS, 'topbar-dark.png'), '.topbar-actions', 8);
      await app.screenshotOf(path.join(SHOTS, 'rail-dark.png'), '#mod-rail', 0);
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'light'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'light'; })()`);
      await app.evaluate(`document.getElementById('new-session-btn').click()`);
      await sleep(800);
    }

    // ---------- Layout: collapse, resize, close and reopen, remembered across a relaunch ----------
    if (want('layout')) {
      const ctxBefore = (await view(app, 'context/main')).frameId;
      await app.evaluate(`document.querySelector('.rail-section[data-view="context/main"] .rail-head-btn').click()`);
      await sleep(300);
      const ctx = await view(app, 'context/main');
      check('collapse: section collapsed, page kept alive and told it is hidden', ctx.collapsed && !ctx.visible && ctx.frameId === ctxBefore);
      await dbg(app, 'setRailWidth(380)');
      await sleep(400);
      const w = await app.evaluate(`document.querySelector('#mod-rail').getBoundingClientRect().width`);
      check('resize: rail is 380 px', Math.abs(w - 380) < 1, w);
      await checkAligned(app, 'rail 380 px');
      await dbg(app, 'setRailWidth(999)');
      check('resize clamps at 480', (await dbg(app, 'layout()')).railWidth === 480);
      await dbg(app, 'setRailWidth(100)');
      check('resize clamps at 240', (await dbg(app, 'layout()')).railWidth === 240);
      await dbg(app, 'setRailWidth(360)');
      await app.click('#rail-toggle');
      await sleep(300);
      check('close: rail hidden, toggle not pressed', await app.evaluate(`document.querySelector('#mod-rail').hidden && document.querySelector('#rail-toggle').getAttribute('aria-pressed') === 'false'`));
      await checkAligned(app, 'rail closed');
      await shot(app, 'window-rail-closed-light');
      await app.key('e', { meta: true, shift: true });
      await sleep(300);
      check('⌘⇧E reopens the rail', await app.evaluate(`!document.querySelector('#mod-rail').hidden`));
      await checkAligned(app, 'rail reopened at 360 px');
      // The pane resizer still works with the rail open.
      await sleep(600);
      await app.close();
      app = await start(profile);
      await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.hello).length >= 7`, 15_000, 'the rail after a relaunch');
      const lay = await dbg(app, 'layout()');
      const w2 = await app.evaluate(`document.querySelector('#mod-rail').getBoundingClientRect().width`);
      check('relaunch: width, open state and collapsed section remembered', lay.railOpen && lay.railWidth === 360 && Math.abs(w2 - 360) < 1 && lay.collapsed.includes('context/main') && (await view(app, 'context/main')).collapsed, { lay, w2 });
      await checkAligned(app, 'after relaunch');
      await app.evaluate(`document.querySelector('.rail-section[data-view="context/main"] .rail-head-btn').click()`);
      await dbg(app, 'setRailWidth(300)');
      await sleep(400);
    }

    // ---------- Narrow: every bundled rail mod at the rail's narrowest; the pane's tab strip at its narrowest ----------
    if (want('narrow')) {
      const RAIL = ['environment', 'context', 'tasks', 'plan', 'outputs', 'sub-sessions', 'skills'];
      for (const w of [240, 270]) {
        await dbg(app, `setRailWidth(${w})`);
        await paint(app);
        for (const id of RAIL) {
          // A frame scrolled out of the rail's view is not drawn (nor measured again): bring each one in first.
          await app.evaluate(`document.querySelector('.rail-section[data-view="${id}/main"]').scrollIntoView()`);
          await paint(app);
          await sleep(300);
          await paint(app);
          const fit = await frameEval(app, id, FRAME_FIT);
          check(`${id} at ${w} px: no scrollbar, no overflow, no control cut off`, fit && fit.overflowX <= 0 && fit.overflowY <= 0 && fit.scrollbars === 0 && fit.cut.length === 0, fit);
        }
        await app.evaluate(`document.querySelector('.rail-section[data-view="environment/main"]').scrollIntoView()`);
        await paint(app);
        await app.screenshotOf(path.join(SHOTS, `rail-${w}-light.png`), '#mod-rail', 0);
      }
      await dbg(app, 'setRailWidth(300)');

      // The pane at its narrowest (360 px) with the Scheduled tab in front and a count on it.
      const sched = await rpc(app, 'schedules.create', { name: 'Nightly audit', prompt: 'Run npm audit.', when: { kind: 'cron', expr: '0 3 * * *' }, target: 'new', cwd: app.project });
      await app.evaluate(`(() => { if (document.querySelector('.shell').classList.contains('pane-hidden')) document.querySelector('#browser-toggle').click(); })()`);
      await app.waitFor(`Boolean(document.querySelector('.mod-pane-tab[data-view="scheduled/main"]'))`, 10_000, 'the Scheduled tab');
      await app.click('.mod-pane-tab[data-view="scheduled/main"]');
      await app.waitFor(`!document.querySelector('.mod-pane-tab[data-view="scheduled/main"] .count-badge').hidden`, 10_000, 'the Scheduled count');
      const STRIP = `(() => {
        const strip = document.querySelector('.pane-tabs');
        const tabs = [...strip.querySelectorAll(':scope > [role=tab]')].filter((t) => !t.hidden);
        const box = (e) => e.getBoundingClientRect();
        const sticksOut = [];
        for (const t of tabs) for (const k of t.children) { const b = box(k); if (b.width > 1 && (b.left < box(t).left - 0.5 || b.right > box(t).right + 0.5)) sticksOut.push(t.id + ' ' + k.className); }
        const overlaps = tabs.slice(1).filter((t, i) => box(t).left < box(tabs[i]).right - 0.5).map((t) => t.id);
        const named = tabs.every((t) => (t.getAttribute('aria-label') || t.textContent).trim().length > 0);
        const tips = tabs.filter((t) => t.classList.contains('icon-only') || (t.querySelector('.pane-tab-label') && t.querySelector('.pane-tab-label').scrollWidth > t.querySelector('.pane-tab-label').clientWidth + 1)).every((t) => !!t.dataset.tip);
        const front = tabs.find((t) => t.getAttribute('aria-selected') === 'true');
        const frontLabel = front && front.querySelector('.pane-tab-label');
        return { pane: Math.round(box(document.getElementById('side-pane')).width), overflow: strip.scrollWidth - strip.clientWidth, sticksOut, overlaps, named, tips, frontWhole: !!frontLabel && !front.classList.contains('icon-only') && frontLabel.scrollWidth <= frontLabel.clientWidth + 1, iconOnly: tabs.filter((t) => t.classList.contains('icon-only')).length };
      })()`;
      for (const w of [360, 440, 520]) {
        await app.evaluate(`document.getElementById('side-pane').style.setProperty('--browser-w', '${w}px')`);
        await paint(app);
        const st = await app.evaluate(STRIP);
        check(`pane tabs at ${w} px: nothing clipped, no badge over a neighbour, every tab named, shortened ones have a tooltip, the front tab whole`, st.overflow <= 0 && !st.sticksOut.length && !st.overlaps.length && st.named && st.tips && st.frontWhole, st);
        await app.screenshotOf(path.join(SHOTS, `pane-tabs-${w}-light.png`), '.pane-tabs', 0);
      }
      await app.evaluate(`document.getElementById('side-pane').style.removeProperty('--browser-w')`);
      await app.click('#pane-tab-browser');
      if (sched && sched.id) await rpc(app, 'schedules.remove', sched.id);
      await paint(app);
    }

    // ---------- Hot reload of a user mod, from the offer card on ----------
    if (want('reload')) {
      const before = Object.fromEntries((await views(app)).map((v) => [v.key, v.frameId]));
      writeMod(userMods, 'hello', { name: 'Hello', description: 'A tiny panel for the live check.', icon: 'message', contributes: { views: [{ id: 'main', title: 'Hello', entry: 'panel.html', seat: 'rail', order: 15 }] } }, { 'panel.html': HELLO(1) });
      await app.waitFor(`Boolean(document.querySelector('.mod-offer[data-mod="hello"] .mod-offer-on'))`, 10_000, 'the offer card').catch(() => {});
      check('offer card appears in the chat', await app.exists('.mod-offer[data-mod="hello"] .mod-offer-on'));
      await app.evaluate(`document.querySelector('.mod-offer[data-mod="hello"]').scrollIntoView()`);
      await app.screenshotOf(path.join(SHOTS, 'offer-card-light.png'), '.mod-offer[data-mod="hello"]', 12);
      await app.click('.mod-offer[data-mod="hello"] .mod-offer-on');
      await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'hello/main' && v.hello)`, 10_000, 'the hello section').catch(() => {});
      const hv = await view(app, 'hello/main');
      check('turned on: section appears and says hello', hv && hv.hello && hv.title === 'Hello v1', hv);
      check('card collapsed to one line', await app.evaluate(`document.querySelector('.mod-offer[data-mod="hello"]').classList.contains('done')`));
      const mid = Object.fromEntries((await views(app)).map((v) => [v.key, v.frameId]));
      fs.writeFileSync(path.join(userMods, 'hello', 'panel.html'), HELLO(2));
      const t0 = Date.now();
      await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'hello/main')?.title === 'Hello v2'`, 5000, 'the edit to show').catch(() => {});
      const took = Date.now() - t0;
      const after = Object.fromEntries((await views(app)).map((v) => [v.key, v.frameId]));
      check('edit on disk shows within a second', (await view(app, 'hello/main')).title === 'Hello v2' && took < 1500, `${took} ms`);
      check('the other sections did not reload', Object.keys(before).every((k) => after[k] === before[k]) && after['hello/main'] !== mid['hello/main'], { before, after });
      fs.writeFileSync(path.join(userMods, 'hello', 'mod.json'), '{ "protocol": 1, "id": "hello", broken');
      await sleep(1500);
      const broken = (await dbg(app, 'list()')).find((m) => m.key === 'hello');
      const hv2 = await view(app, 'hello/main');
      check('broken mod.json: keeps running with a problem listed', hv2 && hv2.hello && !hv2.failed && broken.state === 'on' && broken.problems.some((p) => p.kind === 'manifest'), broken && broken.problems);
      writeMod(userMods, 'hello', { name: 'Hello', description: 'A tiny panel for the live check.', icon: 'message', permissions: ['session:read'], contributes: { views: [{ id: 'main', title: 'Hello', entry: 'panel.html', seat: 'rail', order: 15 }] } }, { 'panel.html': HELLO(2) });
      await app.waitFor(`!window.__oc_debug.mods.views().some((v) => v.key === 'hello/main')`, 5000, 'the paused mod to leave the rail').catch(() => {});
      const paused = (await dbg(app, 'list()')).find((m) => m.key === 'hello');
      check('added permission: paused and removed from the rail', paused.state === 'paused' && !(await view(app, 'hello/main')), paused.state);
      await app.waitFor(`Boolean(document.querySelector('.mod-offer[data-mod="hello"]:not(.done)'))`, 5000, 'a new offer').catch(() => {});
      check('a new offer card asks for the permission', await app.evaluate(`(document.querySelector('.mod-offer[data-mod="hello"]:not(.done)')?.innerText || '').includes('Read the session on screen')`));
      await app.screenshotOf(path.join(SHOTS, 'offer-card-paused-light.png'), '.mod-offer[data-mod="hello"]:not(.done)', 12).catch(() => {});
      await app.click('.mod-offer[data-mod="hello"]:not(.done) .mod-offer-later');
      check('"Not now" collapses the card', await app.evaluate(`!document.querySelector('.mod-offer[data-mod="hello"]:not(.done)')`));
    }

    // ---------- The other seats, styles, and the background ----------
    if (want('seats')) {
      writeMod(userMods, 'tabby', { name: 'Tabby', icon: 'clock', contributes: { views: [{ id: 'main', title: 'Tabby', entry: 'tab.html', seat: 'tab' }] } }, {
        'tab.html': page(`<p class="h-muted">A tab mod.</p>`, `const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
          let vis = 0; harness.on('visibility.changed', (v) => { vis++; harness.ui.setBadge(v.visible ? 'shown' : 'hidden'); });
          harness.ready.then(() => harness.ui.setTitle('Tabby ' + accent()));
          harness.on('theme.changed', () => setTimeout(() => harness.ui.setTitle('Tabby ' + accent()), 0));`),
      });
      writeMod(userMods, 'stripy', { name: 'Stripy', contributes: { views: [{ id: 'main', title: 'Stripy', entry: 'strip.html', seat: 'composer' }] } }, {
        'strip.html': page(`<div class="h-row" style="padding:0 4px"><span class="h-label">A composer strip mod</span><span class="h-chip accent">strip</span></div>`, ``).replace('<link', '<style>:root{--h-inset-x:0;--h-inset-top:0;--h-inset-bottom:0}</style><link'),
      });
      writeMod(userMods, 'backdrop', { name: 'Backdrop', contributes: { views: [{ id: 'main', title: 'Backdrop', entry: 'bg.html', seat: 'background' }] } }, {
        'bg.html': `<!doctype html><style>html,body{margin:0;height:100%}body{background:radial-gradient(circle at 20% 30%,#f2a65a,transparent 50%),radial-gradient(circle at 80% 70%,#5a8df2,transparent 55%),linear-gradient(135deg,#2d1b4e,#1b4e3d)}</style><script src="/@harness/harness.js"></script>`,
      });
      // A theme of yours from before themes were removed: it loads, its CSS is never applied
      writeMod(userMods, 'tint', { name: 'Tint', contributes: { styles: ['theme.css'] } }, { 'theme.css': ':root { --accent: #2b6cb0; }' });
      await sleep(1200);
      // The background is a look: approved at its first Use, not turned on (used once here, so its chat card is
      // settled before the window is measured, then back to Default)
      for (const id of ['tabby', 'stripy', 'tint']) await rpc(app, 'mods.setEnabled', id, true);
      await rpc(app, 'mods.use', { background: 'backdrop/main' }, { approve: true });
      await rpc(app, 'mods.use', { background: null });
      await sleep(800);
      // Tab
      const tabBtn = await app.waitFor(`document.querySelector('.mod-pane-tab[data-view="tabby/main"]') ? true : false`, 5000, 'the tab button').catch(() => false);
      check('tab mod: a tab after Browser, Diff and Terminal', tabBtn && (await app.evaluate(`(() => { const t = [...document.querySelectorAll('.pane-tabs [role=tab]')].map((b) => b.dataset.view || b.id); return t.indexOf('pane-tab-terminal') >= 0 && t.indexOf('pane-tab-terminal') < t.indexOf('tabby/main'); })()`)));
      check('tab mod: no frame before it is first shown', !(await view(app, 'tabby/main')).frameId);
      await app.click('.mod-pane-tab[data-view="tabby/main"]');
      await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'tabby/main')?.hello`, 5000, 'the tab page').catch(() => {});
      const tv = await view(app, 'tabby/main');
      check('tab mod: fills the pane and says hello', tv.hello && (await app.evaluate(`(() => { const f = document.querySelector('.mod-tab-panel:not([hidden]) iframe'); const p = document.querySelector('#side-pane').getBoundingClientRect(); return f && f.getBoundingClientRect().height > p.height - 60; })()`)));
      await checkHidden(app, 'a mod tab in front');
      await sleep(700);
      await shot(app, 'seat-tab-light');
      const tabFrame = tv.frameId;
      await app.click('#pane-tab-browser');
      await sleep(300);
      check('tab mod: kept alive while hidden and told so', (await view(app, 'tabby/main')).frameId === tabFrame && (await view(app, 'tabby/main')).badge === 'hidden');
      await checkAligned(app, 'back on the Browser tab');
      // ⋯ menu lists it
      await app.click('#mods-more');
      await sleep(250);
      const menu = await app.evaluate(`document.querySelector('.popover.mods-menu')?.innerText || ''`);
      check('⋯ menu lists the mod tab and Manage mods…', /Tabby/.test(menu) && /Manage mods/.test(menu), menu);
      await checkHidden(app, 'the ⋯ menu open');
      await app.screenshot(path.join(SHOTS, 'more-menu-light.png'), { x: 900, y: 0, width: 540, height: 260 });
      await app.key('Escape');
      await sleep(300);
      await checkAligned(app, 'menu closed');
      // Composer strip
      const sv = await view(app, 'stripy/main');
      check('composer mod: sits directly above the composer, sized to content', sv && sv.hello && sv.height > 10 && sv.height <= 120 && (await app.evaluate(`document.querySelector('#mod-strip').nextElementSibling.id === 'chatbar' && document.querySelector('#chatbar').firstElementChild.id === 'composer' && !document.querySelector('#mod-strip').hidden`)), sv);
      await app.screenshotOf(path.join(SHOTS, 'seat-composer-light.png'), '.composer-wrap', 8);
      // An old theme (contributes.styles): listed with a note, never applied
      const tint = (await dbg(app, 'list()')).find((m) => m.key === 'tint');
      check('an old theme loads with a note, and its CSS never reaches the window', tint && tint.state !== 'invalid' && tint.problems.some((p) => p.warning && /Themes were removed/.test(p.message)) && (await app.evaluate(`!document.querySelector('style[data-mod]') && getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#1f66c4'`)), tint && tint.problems);
      await rpc(app, 'mods.setEnabled', 'tint', false);
      // The scheme: the app's tokens reach every mod page through theme.changed
      await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'tabby/main')?.title === 'Tabby #1f66c4'`, 5000, 'the accent in the tab page').catch(() => {});
      check("the app's accent reaches a mod page's own CSS", (await view(app, 'tabby/main')).title === 'Tabby #1f66c4', (await view(app, 'tabby/main')).title);
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'dark'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'dark'; })()`);
      await sleep(800);
      const darkAccent = await app.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
      await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'tabby/main')?.title === ${JSON.stringify('Tabby ' + darkAccent)}`, 5000, 'the dark accent in the tab page').catch(() => {});
      check('dark: theme.changed reached the bundled views and the tab page has the dark accent', (await dbg(app, 'log()')).some((e) => e.kind === 'event' && e.method === 'theme.changed' && e.view === 'tasks/main') && (await view(app, 'tabby/main')).title === `Tabby ${darkAccent}`, { darkAccent, title: (await view(app, 'tabby/main')).title });
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'light'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'light'; })()`);
      await sleep(800);
      // Background
      await app.evaluate(`document.activeElement.blur()`);
      await sleep(300);
      await shot(app, 'bg-before-light');
      await rpc(app, 'mods.setLayout', { background: 'backdrop/main' });
      await app.waitFor(`document.documentElement.classList.contains('mod-bg') && window.__oc_debug.mods.views().find((v) => v.key === 'backdrop/main')?.hello`, 5000, 'the background').catch(() => {});
      check('background mod: behind the window, no pointer events', await app.evaluate(`(() => { const l = document.querySelector('#mod-background'); return !l.hidden && getComputedStyle(l).pointerEvents === 'none' && getComputedStyle(l).zIndex === '-1' && !!l.querySelector('iframe'); })()`));
      check('background: composer and cards stay solid', await app.evaluate(`getComputedStyle(document.querySelector('#composer')).backgroundColor.startsWith('rgb(') && !getComputedStyle(document.querySelector('#composer')).backgroundColor.includes('0)')`));
      await sleep(800);
      await shot(app, 'bg-on-light');
      await rpc(app, 'mods.setLayout', { background: null });
      await sleep(1200);
      await app.evaluate(`document.activeElement.blur()`);
      await sleep(300);
      await shot(app, 'bg-after-light');
      // Live content (the Context panel's "updated" time, say) may move a few pixels; the look itself must not.
      const diff = pixelDiff(path.join(SHOTS, 'bg-before-light.png'), path.join(SHOTS, 'bg-after-light.png'));
      check('background off: the window looks as before (pixel diff)', diff < 2000 && !(await app.evaluate(`document.documentElement.classList.contains('mod-bg') || document.documentElement.style.getPropertyValue('--mod-cover') !== ''`)), `${diff} of 5184000 pixels differ`);
      await rpc(app, 'mods.setLayout', { background: 'backdrop/main' });
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'dark'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'dark'; })()`);
      await sleep(1500);
      await shot(app, 'bg-on-dark');
      await rpc(app, 'mods.setLayout', { background: null });
      await sleep(400);
      await shot(app, 'window-seats-dark');
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'light'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'light'; })()`);
      await sleep(1500);
      await shot(app, 'window-seats-light');
    }

    // ---------- Isolation, from inside the real app ----------
    if (want('isolation')) {
      writeMod(userMods, 'probe', { name: 'Probe', contributes: { views: [{ id: 'main', title: 'Probe', entry: 'probe.html', seat: 'rail', order: 99 }] } }, {
        'probe.html': page(`<p class="h-muted">probe</p>`, `const r = {};
          try { r.parent = String(window.parent.document.title); } catch (e) { r.parent = 'blocked'; }
          try { r.oc = typeof window.parent.oc; } catch (e) { r.oc = 'blocked'; }
          harness.ready.then(async () => {
            try { await harness.session.get(); r.perm = 'allowed'; } catch (e) { r.perm = String(e.rpcCode); }
            try { await harness.call('events.subscribe', { events: ['tasks.changed'] }); r.sub = 'allowed'; } catch (e) { r.sub = String(e.rpcCode); }
            try { await fetch('https://example.com/', { mode: 'no-cors' }); r.net = 'reached'; } catch (e) { r.net = 'blocked'; }
            harness.ui.setTitle(JSON.stringify(r));
          });`),
      });
      await sleep(1200);
      await rpc(app, 'mods.setEnabled', 'probe', true);
      await app.waitFor(`(window.__oc_debug.mods.views().find((v) => v.key === 'probe/main')?.title || '').includes('net')`, 10_000, 'the probe').catch(() => {});
      let r = {};
      try {
        r = JSON.parse((await view(app, 'probe/main')).title);
      } catch {
        /* no result */
      }
      check('isolation: window.parent is out of reach', r.parent === 'blocked' && r.oc === 'blocked', r);
      check('isolation: a method without its permission is refused with 4003', r.perm === '4003', r);
      check('isolation: subscribing to an event without its permission is refused with 4003', r.sub === '4003', r);
      check('isolation: no network without the network permission', r.net === 'blocked', r);
      // A frame the host did not make, showing the same mod page: its hello is ignored.
      const src = (await view(app, 'probe/main')).src;
      await dbg(app, 'clearLog()');
      await app.evaluate(`(() => { const f = document.createElement('iframe'); f.id = 'stranger'; f.setAttribute('sandbox', 'allow-scripts'); f.src = ${JSON.stringify(src)}; f.style.cssText = 'position:fixed;width:10px;height:10px;left:0;bottom:0;opacity:0'; document.body.appendChild(f); window.postMessage({ jsonrpc: '2.0', id: 9, method: 'ui.toast', params: { text: 'from nowhere' } }, '*'); })()`);
      await sleep(2500);
      const lg = await dbg(app, 'log()');
      check('isolation: messages from a frame the host did not make are ignored', lg.some((e) => e.kind === 'ignored') && !lg.some((e) => e.kind !== 'ignored' && e.method === 'hello'), lg.slice(0, 8));
      await app.evaluate(`document.getElementById('stranger')?.remove()`);
      // Dialogs hide the browser view.
      await app.click('#pane-tab-browser');
      await app.click('#settings-btn');
      await checkHidden(app, 'Settings open');
      await app.click('#settings-close');
      await checkAligned(app, 'Settings closed');
    }

    // ---------- The agent writes a mod (needs the API) ----------
    if (want('agent') && app.live) {
      await app.evaluate(`document.getElementById('new-session-btn').click()`);
      await sleep(800);
      await app.send("Make a mod for this project that shows the current session's title and message count in the right-hand rail.");
      await app.waitIdle(240_000);
      const tr = await app.transcript();
      const text = tr.map((t) => t.text).join('\n');
      check('agent: loaded the create-mod skill', /create-mod/.test(text), text.slice(0, 300));
      // The row reads "Check mod <id>" on screen; what was called is in the stored transcript.
      const calls = await app.evaluate(`(async () => (await oc.rpc('sessions.transcript', (await oc.sessions.current()).id)).filter((i) => i.role === 'tool').map((i) => i.name))()`);
      check('agent: called mod_check', calls.includes('mod_check') && /Check mod/.test(text), calls);
      await app.waitFor(`Boolean(document.querySelector('.mod-offer:not(.done) .mod-offer-on'))`, 15_000, 'the offer card for the new mod').catch(() => {});
      const key = await app.evaluate(`document.querySelector('.mod-offer:not(.done)')?.dataset.mod || ''`);
      check('agent: an offer card for the new mod', !!key, key);
      if (key) {
        await app.screenshotOf(path.join(SHOTS, 'agent-offer-light.png'), `.mod-offer[data-mod="${key}"]`, 12);
        await app.click(`.mod-offer[data-mod="${key}"] .mod-offer-on`);
        await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.mod === ${JSON.stringify(key)} && v.hello)`, 10_000, 'the agent mod to start').catch(() => {});
        const av = (await views(app)).find((v) => v.mod === key);
        check('agent: its view renders in the rail', av && av.hello && !av.failed && av.height > 10, av);
        const errs = (await errors(app)).filter((e) => e.view.startsWith(key));
        check('agent: no refused or failed calls from its page', errs.length === 0, errs);
        const list = (await dbg(app, 'list()')).find((m) => m.key === key);
        check('agent: no problems listed', list && !list.problems.length, list && list.problems);
        if (av) {
          await app.evaluate(`window.__oc_debug.mods.open(${JSON.stringify(av.key)})`);
          await sleep(500);
          await app.screenshotOf(path.join(SHOTS, 'agent-mod-section-light.png'), `.rail-section[data-view="${av.key}"]`, 0);
        }
        await shot(app, 'agent-mod-light');
      }
    } else if (want('agent')) console.log('skip agent: no API key (mock model)');
  } catch (err) {
    check('no exception', false, String(err && err.stack || err));
  } finally {
    const lines = app.console.filter((l) => /\[(error|exception)\]/.test(l));
    if (lines.length) console.log('console:\n' + lines.slice(-15).join('\n'));
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
