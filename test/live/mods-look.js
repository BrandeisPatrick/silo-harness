// Live checks of the look mods in the real window, through the rig: mods/backgrounds (each view, light and dark, at
// two dims; readability measured from the pixels; CPU while it animates; off restores the look), the chat bar under
// the themes (geometry and every state, a real message sent through it; its look was the composer-pill mod's and is
// the app's own now), mods/theme-midnight (the window, Settings, an approval card, a diff, the rail mods following it),
// all of them together, and the kit's h-md class at rail and tab width.
// Run: npm run build && node test/live/mods-look.js [phase…]   phases: backgrounds chatbar theme all md
// Screenshots go to $SHOTS (default: a temp folder).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-look-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const only = new Set(process.argv.slice(2));
const want = (phase) => !only.size || only.has(phase);
const { check, done } = checker();
const shot = (app, name, clip) => app.screenshot(path.join(SHOTS, `${name}.png`), clip);
const file = (name) => path.join(SHOTS, `${name}.png`);

const dbg = (app, expr) => app.evaluate(`window.__oc_debug.mods.${expr}`);
const views = (app) => dbg(app, 'views()');
const view = async (app, key) => (await views(app)).find((v) => v.key === key);
const rpc = (app, method, ...args) => app.evaluate(`window.oc.rpc(${JSON.stringify(method)}, ...${JSON.stringify(args)})`);

async function setTheme(app, scheme) {
  await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = ${JSON.stringify(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${JSON.stringify(scheme)}; })()`);
  await sleep(900);
}

async function enable(app, id, on) {
  await rpc(app, 'mods.setEnabled', id, on);
  await sleep(900);
}

/** CPU seconds used so far by the app: its main process and every process under it (renderers, GPU, helpers). */
function cpuSeconds(rootPid) {
  const parse = (t) => {
    let days = 0;
    if (t.includes('-')) [days, t] = [Number(t.split('-')[0]), t.split('-')[1]];
    return days * 86400 + t.split(':').reduce((s, p) => s * 60 + Number(p), 0);
  };
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .map(([pid, ppid, time]) => ({ pid: Number(pid), ppid: Number(ppid), t: parse(time) }));
  const kids = new Map();
  for (const r of rows) (kids.get(r.ppid) || kids.set(r.ppid, []).get(r.ppid)).push(r);
  let sum = 0;
  const stack = [rows.find((r) => r.pid === rootPid)].filter(Boolean);
  while (stack.length) {
    const r = stack.pop();
    sum += r.t;
    stack.push(...(kids.get(r.pid) || []));
  }
  return sum;
}

async function cpuOver(app, seconds) {
  const a = cpuSeconds(app.child.pid);
  await sleep(seconds * 1000);
  return cpuSeconds(app.child.pid) - a;
}

/** Decodes a PNG screenshot to RGBA pixels (CDP's screenshots are 8-bit RGB, colour type 2; RGBA is type 6). */
function pixels(f) {
  const zlib = require('node:zlib');
  const b = fs.readFileSync(f);
  let i = 8;
  let w = 0;
  let h = 0;
  let ctype = 6;
  const idat = [];
  while (i < b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') {
      w = b.readUInt32BE(i + 8);
      h = b.readUInt32BE(i + 12);
      ctype = b[i + 17];
    }
    if (type === 'IDAT') idat.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const d = zlib.inflateSync(Buffer.concat(idat));
  const bpp = ctype === 2 ? 3 : 4;
  const stride = w * bpp + 1;
  const raw = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const ft = d[y * stride];
    for (let x = 0; x < w * bpp; x++) {
      const r = d[y * stride + 1 + x];
      const a = x >= bpp ? raw[y * w * bpp + x - bpp] : 0;
      const up = y ? raw[(y - 1) * w * bpp + x] : 0;
      const c = x >= bpp && y ? raw[(y - 1) * w * bpp + x - bpp] : 0;
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
      raw[y * w * bpp + x] = v & 255;
    }
  }
  if (bpp === 4) return { w, h, out: raw };
  const out = Buffer.alloc(w * h * 4);
  for (let p = 0, q = 0; p < raw.length; p += 3, q += 4) {
    out[q] = raw[p];
    out[q + 1] = raw[p + 1];
    out[q + 2] = raw[p + 2];
    out[q + 3] = 255;
  }
  return { w, h, out };
}

/** Pixels that differ between two screenshots; `maxX` (CSS px) limits it to the part left of that line. */
function pixelDiff(fa, fb, maxX = Infinity) {
  const a = pixels(fa);
  const b = pixels(fb);
  if (a.w !== b.w || a.h !== b.h) return Infinity;
  const lim = Math.min(a.w, maxX * 2);
  let n = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < lim; x++) {
    const i = (y * a.w + x) * 4;
    if (a.out[i] !== b.out[i] || a.out[i + 1] !== b.out[i + 1] || a.out[i + 2] !== b.out[i + 2]) n++;
  }
  return n;
}

const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

/**
 * The worst contrast text would have over what shows behind it: samples the screenshot in the empty margins of the
 * chat (beside the column, where only the background and the translucent surface are) and in the sidebar's empty
 * foot, against the text-100 and text-400 colours in effect.
 */
async function readability(app, png) {
  const geo = await app.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgb = (v) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = v; probe.fillRect(0, 0, 1, 1); return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
    const col = document.querySelector('#messages').getBoundingClientRect();
    const main = document.querySelector('.transcript-wrap').getBoundingClientRect();
    const comp = document.querySelector('.composer-wrap').getBoundingClientRect();
    const side = document.querySelector('.sidebar')?.getBoundingClientRect();
    const inner = document.querySelector('#messages > *:not([hidden])')?.getBoundingClientRect() || col;
    return { t100: rgb(cs.getPropertyValue('--text-100')), t400: rgb(cs.getPropertyValue('--text-400')), main: { x: main.x, y: main.y, r: main.right, b: comp.top }, col: { x: Math.min(comp.left, inner.left), r: Math.max(comp.right, inner.right) }, side: side && { x: side.x, r: side.right, y: side.bottom - 120, b: side.bottom - 70 } };
  })()`);
  const { w, out } = pixels(png);
  const px = (x, y) => {
    const i = (Math.round(y * 2) * w + Math.round(x * 2)) * 4;
    return [out[i], out[i + 1], out[i + 2]];
  };
  let worst100 = Infinity;
  let worst400 = Infinity;
  const sample = (x0, x1, y0, y1) => {
    for (let y = y0; y < y1; y += 9) for (let x = x0; x < x1; x += 9) {
      const p = px(x, y);
      worst100 = Math.min(worst100, ratio(p, geo.t100));
      worst400 = Math.min(worst400, ratio(p, geo.t400));
    }
  };
  sample(geo.main.x + 12, geo.col.x - 16, geo.main.y + 60, geo.main.b - 20);
  sample(geo.col.r + 16, geo.main.r - 12, geo.main.y + 60, geo.main.b - 20);
  if (geo.side) sample(geo.side.x + 12, geo.side.r - 12, geo.side.y, geo.side.b);
  return { text: Number(worst100.toFixed(2)), muted: Number(worst400.toFixed(2)) };
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

/** A conversation on screen without the model: a question, a reply with code and a table, a tool row. */
async function seed(app) {
  await app.evaluate(`(() => {
    window.__oc_debug.user('Can you make the retry backoff configurable and fix the flaky login test?');
    window.__oc_debug.renderMarkdown(${JSON.stringify(
      "Sure. The retry loop in `src/auth/login.ts` waits a fixed **3 seconds**; I'll take the delay from the options instead.\n\n" +
        '## What changes\n\n- `LoginOptions` gets `backoffMs` (default 500)\n- each retry waits `backoffMs * 2 ** attempt`\n- the test uses fake timers, so it no longer depends on the clock\n\n' +
        '```ts\nexport async function login(opts: LoginOptions) {\n  for (let i = 0; i < 3; i++) {\n    const res = await post("/login", opts); // retry on 503\n    if (res.ok) return res;\n    await sleep(opts.backoffMs * 2 ** i);\n  }\n}\n```\n\n' +
        '| Attempt | Wait |\n| --- | --- |\n| 1 | 500 ms |\n| 2 | 1 s |\n| 3 | 2 s |\n\n> Muted text, like this note, has to stay readable too.',
    )});
  })()`);
  await sleep(300);
}

async function seedCards(app) {
  await app.evaluate(`(() => {
    const e = window.__oc_debug.emit;
    e({ type: 'tool_start', id: 'd1', name: 'edit_file', args: { path: 'src/auth/login.ts', old_string: '    await sleep(3000);\\n  }', new_string: '    await sleep(opts.backoffMs * 2 ** i);\\n  }\\n  throw new Error("login failed");' } });
    e({ type: 'tool_end', id: 'd1', name: 'edit_file', result: 'Edited src/auth/login.ts (+2 -1)', ok: true });
    e({ type: 'tool_start', id: 'b1', name: 'bash', args: { command: 'npm test -- test/auth/login.test.ts' } });
    e({ type: 'approval_request', id: 'ap-1', name: 'bash', detail: 'npm test -- test/auth/login.test.ts', mode: 'ask', alwaysLabel: 'Allow npm for this session', projectLabel: 'Always allow npm in this project' });
  })()`);
  await sleep(400);
}

const BGS = ['aurora', 'constellation', 'grid', 'dusk'];

(async () => {
  // A profile that had the retired composer-pill mod turned on: the stale entry must do nothing
  const app = await launch({ mode: 'bypass', config: { theme: 'light', mods: { enabled: { 'composer-pill': { permissions: [], styles: true } } } } });
  console.log(`model: ${app.live ? 'real API' : 'mock model (no key)'}; screenshots: ${SHOTS}`);
  try {
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.hello).length >= 7`, 15_000, 'the rail to start');
    // The look mods are bundled and have no switch: available (approved), off until one of their looks is used
    const list = await dbg(app, 'list()');
    const st = (id) => list.find((m) => m.id === id)?.state;
    const ok = (id) => list.find((m) => m.id === id)?.approved === true;
    check('bundled looks: backgrounds, theme-midnight and theme-paper available and off until used, nothing shown', ['backgrounds', 'theme-midnight', 'theme-paper'].every((id) => st(id) === 'off' && ok(id)) && !(await app.evaluate(`document.documentElement.classList.contains('mod-bg') || !!document.querySelector('style[data-mod]')`)), { b: st('backgrounds'), t: st('theme-midnight'), p: st('theme-paper') });
    const stale = list.filter((m) => m.id === 'composer-pill');
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l) && /composer-pill|mod/i.test(l));
    check('a stale composer-pill entry from an older profile: no such mod, no styles, no error', stale.length === 0 && !(await app.exists('style[data-mod="composer-pill"]')) && errors.length === 0, { stale, errors });
    const tokens = (await dbg(app, 'theme()')).tokens;
    check('the tokens sent to mods include the Markdown ones', ['--code-bg', '--code-hover', '--bubble', '--tok-kw', '--tok-str', '--tok-com', '--tok-num', '--tok-pun'].every((k) => tokens[k]), Object.keys(tokens).filter((k) => /code|bubble|tok/.test(k)));
    if (await app.exists('#pane-close')) await app.click('#pane-close');
    await seed(app);
    await app.evaluate(`document.activeElement.blur()`);
    await sleep(400);

    // ---------- Backgrounds ----------
    if (want('backgrounds')) {
      const picker = await app.evaluate(`(async () => { const l = await window.oc.rpc('mods.list'); return l.find((m) => m.id === 'backgrounds').manifest.contributes.views.map((v) => v.id); })()`);
      check('backgrounds: four views to pick from', JSON.stringify(picker) === JSON.stringify(BGS), picker);
      await shot(app, 'bg-none-light');
      const cpuNone = await cpuOver(app, 10);
      const results = {};
      for (const scheme of ['light', 'dark']) {
        await setTheme(app, scheme);
        if (scheme === 'dark') await shot(app, 'bg-none-dark');
        for (const id of BGS) {
          for (const dim of [0.82, 0.6]) {
            await rpc(app, 'mods.setLayout', { background: `backgrounds/${id}`, backgroundDim: dim });
            await app.waitFor(`window.__oc_debug.mods.views().find((v) => v.key === 'backgrounds/${id}')?.hello`, 8000, `the ${id} background`).catch(() => {});
            await sleep(1500);
            const name = `bg-${id}-${scheme}-${dim}`;
            await shot(app, name);
            const r = await readability(app, file(name));
            results[name] = r;
            check(`${name}: text over the background stays readable (text ≥ 4.5, muted ≥ 3)`, r.text >= 4.5 && r.muted >= 3, r);
          }
          const v = await view(app, `backgrounds/${id}`);
          check(`${id} (${scheme}): said hello, no failure`, v && v.hello && !v.failed, v);
        }
      }
      // Solid surfaces over a background
      await rpc(app, 'mods.setLayout', { background: 'backgrounds/aurora', backgroundDim: 0.6 });
      await sleep(1000);
      await seedCards(app);
      await app.click('#model-btn');
      await sleep(400);
      const solid = await app.evaluate(`(() => { const a = (s) => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e).backgroundColor; const slash = /\\/\\s*([\\d.]+)\\s*\\)\\s*$/.exec(c); if (slash) return Number(slash[1]); const m = /rgba\\(([^)]+)\\)/.exec(c); return m ? Number(m[1].split(',')[3]) : 1; };  return { composer: a('#composer'), popover: a('.popover'), approval: a('.approval'), main: a('.main') }; })()`);
      check('background: composer, popover and approval card stay solid; the page surface lets it through', solid.composer === 1 && solid.popover === 1 && solid.approval === 1 && solid.main < 1, solid);
      await shot(app, 'bg-aurora-dark-0.6-cards');
      await app.key('Escape');
      await sleep(200);
      // Motion: three of them move, dusk holds still; each pauses when the frame is hidden
      await setTheme(app, 'light');
      const cpu = { none: cpuNone };
      for (const id of BGS) {
        await rpc(app, 'mods.setLayout', { background: `backgrounds/${id}`, backgroundDim: 0.82 });
        await sleep(1500);
        await shot(app, `motion-${id}-a`);
        await sleep(1500);
        await shot(app, `motion-${id}-b`);
        const moved = pixelDiff(file(`motion-${id}-a`), file(`motion-${id}-b`), 1080);
        check(`${id}: ${id === 'dusk' ? 'holds still' : 'moves'}`, id === 'dusk' ? moved < 200 : moved > 1000, `${moved} pixels changed in 1.5 s`);
        cpu[id] = await cpuOver(app, 10);
        // Other work on the machine only ever adds to the figure: one over the budget is measured again, the lower counts.
        if (cpu[id] - cpu.none >= 1.0) cpu[id] = Math.min(cpu[id], await cpuOver(app, 10));
      }
      const vis = await frameEval(app, 'backgrounds', 'document.visibilityState');
      console.log(`CPU seconds over 10 s (all app processes): ${Object.entries(cpu).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}; background frame visibilityState: ${vis}`);
      check('backgrounds: an animating background costs under 0.1 s of CPU per second over none', BGS.every((id) => cpu[id] - cpu.none < 1.0), cpu);
      // Reduced motion: a still frame. Media emulation does not reach the out-of-process background frame, so the
      // frame's own query object is switched to "reduce" and told so (the change event the page listens for).
      await rpc(app, 'mods.setLayout', { background: 'backgrounds/aurora' });
      await sleep(1200);
      const switched = await frameEval(app, 'backgrounds', `(() => { Object.defineProperty(reduced, 'matches', { value: true, configurable: true }); reduced.dispatchEvent(new Event('change')); return reduced.matches; })()`);
      await sleep(800);
      await shot(app, 'reduced-a');
      await sleep(1500);
      await shot(app, 'reduced-b');
      const still = pixelDiff(file('reduced-a'), file('reduced-b'), 1080);
      check('backgrounds: reduced motion holds a still frame', switched === true && still < 200, `${still} pixels changed (switched: ${switched})`);
      await frameEval(app, 'backgrounds', `(() => { delete reduced.matches; reduced.dispatchEvent(new Event('change')); return reduced.matches; })()`);
      // Settings: vivid, and slow
      await rpc(app, 'mods.setSetting', 'backgrounds', 'intensity', 'vivid');
      await rpc(app, 'mods.setLayout', { background: 'backgrounds/aurora', backgroundDim: 0.6 });
      await sleep(1200);
      await shot(app, 'bg-aurora-light-0.6-vivid');
      const vivid = await readability(app, file('bg-aurora-light-0.6-vivid'));
      check('aurora vivid at dim 0.6 (light): still readable', vivid.text >= 4.5 && vivid.muted >= 3, vivid);
      await setTheme(app, 'dark');
      await sleep(600);
      await shot(app, 'bg-aurora-dark-0.6-vivid');
      const vividD = await readability(app, file('bg-aurora-dark-0.6-vivid'));
      check('aurora vivid at dim 0.6 (dark): still readable', vividD.text >= 4.5 && vividD.muted >= 3, vividD);
      for (const id of ['constellation', 'grid']) {
        await rpc(app, 'mods.setLayout', { background: `backgrounds/${id}` });
        await sleep(1200);
        await shot(app, `bg-${id}-dark-0.6-vivid`);
      }
      await rpc(app, 'mods.setSetting', 'backgrounds', 'intensity', 'subtle');
      await setTheme(app, 'light');
      // Off restores the exact look: the same window without a background, before and after one was on
      await app.evaluate(`(() => { const e = window.__oc_debug.emit; e({ type: 'approval_resolved', id: 'ap-1', ok: true, scope: 'once' }); e({ type: 'tool_end', id: 'b1', name: 'bash', result: 'PASS', ok: true }); })()`);
      await rpc(app, 'mods.setLayout', { background: null, backgroundDim: 0.82 });
      await sleep(1200);
      await app.evaluate(`document.activeElement.blur()`);
      await shot(app, 'bg-off-before');
      for (const id of BGS) {
        await rpc(app, 'mods.setLayout', { background: `backgrounds/${id}` });
        await sleep(900);
      }
      await rpc(app, 'mods.setLayout', { background: null });
      await sleep(1200);
      await shot(app, 'bg-off-after');
      const diff = pixelDiff(file('bg-off-before'), file('bg-off-after'));
      check('background off: the window looks as it did before (pixel diff)', diff < 2000 && !(await app.evaluate(`document.documentElement.classList.contains('mod-bg') || document.documentElement.style.getPropertyValue('--mod-cover') !== ''`)), `${diff} pixels differ`);
      console.log('readability:', JSON.stringify(results));
    }

    // ---------- The chat bar under the themes ----------
    if (want('chatbar')) {
      await app.evaluate(`window.__oc_debug.context({ tokens: 23400, limit: 200000, threshold: 0.8, autoCompact: true })`);
      const menuAt = (sel) => app.evaluate(`(() => { const m = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); const c = document.querySelector('#composer').getBoundingClientRect(); return { open: !document.querySelector(${JSON.stringify(sel)}).hidden, above: m.bottom <= c.top, left: Math.round(m.left - c.left), right: Math.round(m.right - c.right) }; })()`);
      const clip = async () => {
        const r = await app.evaluate(`(() => { const w = document.querySelector('.composer-wrap').getBoundingClientRect(); const m = [...document.querySelectorAll('.slash-menu:not([hidden]), #queue:not([hidden]), #status-line:not([hidden])')].map((e) => e.getBoundingClientRect().top); const top = Math.min(w.top, ...m); return { x: w.x - 24, y: top - 16, width: w.width + 48, height: w.bottom - top + 16 }; })()`);
        return r;
      };
      const bar = async (name) => shot(app, `chatbar-${name}`, await clip());
      const geo = () => app.evaluate(`(() => { const r = (s) => { const e = document.querySelector(s); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom, cy: b.y + b.height / 2 }; }; const cs = (s, p) => getComputedStyle(document.querySelector(s))[p]; return { comp: r('#composer'), input: r('#input'), attach: r('#attach-btn'), send: r('#send-btn'), foot: r('#composer-foot'), model: r('#model-btn'), mode: r('#mode-btn'), meter: r('#context-meter'), att: r('#attachments'), radius: cs('#composer', 'borderTopLeftRadius'), border: cs('#composer', 'borderTopColor'), chipBorder: cs('#model-btn', 'borderTopStyle'), modeBorder: cs('#mode-btn', 'borderTopStyle') }; })()`);
      const near = (a, b, d = 1.5) => Math.abs(a - b) <= d;
      for (const theme of [false, true]) {
        if (theme) await enable(app, 'theme-midnight', true);
        for (const scheme of ['light', 'dark']) {
          await setTheme(app, scheme);
          const tag = `${scheme}${theme ? '-midnight' : ''}`;
          await app.fill('#input', '');
          await app.evaluate(`document.activeElement.blur()`);
          await sleep(400);
          const g = await geo();
          const ok =
            near(g.comp.h, 46) && g.radius === '12px' &&
            g.attach.r <= g.input.x + 1 && g.send.x >= g.input.r - 1 &&
            near(g.attach.cy, g.input.cy, 2) && near(g.send.cy, g.input.cy, 2) &&
            g.foot.y >= g.comp.b && near(g.model.cy, g.mode.cy) && g.model.x < g.mode.x &&
            (!g.meter || (g.mode.r <= g.meter.x + 1 && near(g.meter.r, g.comp.r - 8, 3))) &&
            g.chipBorder === 'none' && g.modeBorder === 'none';
          check(`chatbar (${tag}): one 46 px bar with the plus left, the field, the action right; model, mode, ring in a borderless row under it, right-aligned`, ok, g);
          await bar(`empty-${tag}`);
          await app.evaluate(`document.querySelector('#input').focus()`);
          await sleep(250);
          check(`chatbar (${tag}): focus shows on the bar's border`, (await geo()).border !== g.border, { before: g.border });
          await bar(`focused-${tag}`);
          await app.fill('#input', 'First line of a longer request\nsecond line with more detail\nthird line');
          await sleep(200);
          const g3 = await geo();
          check(`chatbar (${tag}): three lines grow the bar upward, the plus and the action stay on the last line`, near(g3.input.h, 86) && near(g3.comp.b, g.comp.b) && near(g3.send.cy, g.send.cy) && near(g3.attach.cy, g.attach.cy), { input: g3.input, send: g3.send });
          await bar(`three-lines-${tag}`);
          await app.fill('#input', '');
        }
        if (theme) await enable(app, 'theme-midnight', false);
      }
      await setTheme(app, 'light');
      // Attachments
      await app.evaluate(`(async () => { const mk = (c) => { const k = document.createElement('canvas'); k.width = 240; k.height = 160; const x = k.getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 240, 160); x.fillStyle = '#fff'; x.fillRect(30, 30, 90, 50); return k.toDataURL('image/png'); }; await window.__oc_debug.attach(mk('#3b82f6'), 'one.png'); await window.__oc_debug.attach(mk('#f59e0b'), 'two.png'); })()`);
      await sleep(600);
      await app.evaluate(`document.querySelector('#input').focus()`);
      await sleep(200);
      const ga = await geo();
      const thumb = await app.evaluate(`(() => { const t = document.querySelector('.attachment').getBoundingClientRect(); const c = document.querySelector('#composer').getBoundingClientRect(); return { w: t.width, h: t.height, left: Math.round(t.left - c.left), top: Math.round(t.top - c.top) }; })()`);
      check('chatbar: two attachments sit inside the bar above the field, 120 px, lined up with the text', ga.att && ga.att.b <= ga.input.y + 1 && ga.att.y >= ga.comp.y && (await app.evaluate(`window.__oc_debug.attachments().length`)) === 2 && thumb.w === 120 && thumb.h === 120 && near(thumb.left, 45) && near(thumb.top, 13, 2.5), { att: ga.att, thumb });
      await bar('attachments-light');
      await setTheme(app, 'dark');
      await bar('attachments-dark');
      await setTheme(app, 'light');
      await app.evaluate(`document.querySelectorAll('.attach-remove').forEach((b) => b.click())`);
      await sleep(400);
      // Drag highlight
      const look = () => app.evaluate(`(() => { const s = getComputedStyle(document.querySelector('#composer')); return s.borderTopColor + ' ' + s.boxShadow; })()`);
      const idleLook = await look();
      await app.evaluate(`document.querySelector('#composer').classList.add('dragging')`);
      check('chatbar: a drag over it shows on the bar', (await look()) !== idleLook, idleLook);
      await bar('dragging-light');
      await app.evaluate(`document.querySelector('#composer').classList.remove('dragging')`);
      // Slash menu
      await app.fill('#input', '/');
      await app.waitFor(`!document.querySelector('#slash-menu').hidden`, 4000, 'the slash menu').catch(() => {});
      await sleep(300); // its pop-in animation
      const sm = await menuAt('#slash-menu');
      check('chatbar: the slash menu opens above the bar, as wide as it', sm.open && sm.above && near(sm.left, 0) && near(sm.right, 0), sm);
      await bar('slash-light');
      await setTheme(app, 'dark');
      await app.fill('#input', '/');
      await sleep(500);
      await bar('slash-dark');
      await setTheme(app, 'light');
      await app.fill('#input', '');
      await app.key('Escape');
      // Mention menu
      await app.evaluate(`window.__oc_debug.files.mock([{ path: 'src/auth/login.ts', name: 'login.ts', dir: 'src/auth', isDir: false }, { path: 'src/auth/session.ts', name: 'session.ts', dir: 'src/auth', isDir: false }, { path: 'test/auth', name: 'auth', dir: 'test', isDir: true }])`);
      await app.evaluate(`document.querySelector('#input').focus()`);
      await app.fill('#input', 'Look at @log');
      await app.waitFor(`!document.querySelector('#mention-menu').hidden`, 4000, 'the mention menu').catch(() => {});
      await sleep(300);
      check('chatbar: the mention menu opens above the bar', (await menuAt('#mention-menu')).above);
      await bar('mention-light');
      await app.key('Escape');
      await app.fill('#input', '');
      await app.evaluate(`window.__oc_debug.files.mock(null)`);
      // The mode under the bar: plain text for Auto, a colour for Plan and Bypass
      const modeColour = () => app.evaluate(`[getComputedStyle(document.querySelector('#mode-btn')).color, getComputedStyle(document.querySelector('#model-btn')).color, document.querySelector('#mode-btn').innerText.trim()]`);
      const colours = {};
      for (const mode of ['auto', 'plan', 'bypass']) {
        await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.permissionMode = ${JSON.stringify(mode)}; await window.oc.setConfig(c); })()`);
        await sleep(500);
        colours[mode] = await modeColour();
        await bar(`mode-${mode}-light`);
      }
      check('chatbar: Auto reads as plain text ("Auto"), Plan and Bypass keep a colour', colours.auto[0] === colours.auto[1] && colours.auto[2] === 'Auto' && colours.plan[0] !== colours.plan[1] && colours.bypass[0] !== colours.bypass[1] && colours.plan[0] !== colours.bypass[0], colours);
      // A real message through it, with a second one queued while the first runs
      await app.evaluate(`document.getElementById('new-session-btn').click()`);
      await sleep(800);
      if (!app.live) app.mock.state.replies.push({ content: 'Here are the files.', delayMs: 5000 }); // a run long enough to queue behind
      await app.send(app.live ? 'Run `sleep 6` with bash, then reply with the single word: done.' : 'Run ls');
      await app.waitFor(`!document.querySelector('#status-line').hidden`, 20_000, 'the run to start').catch(() => {});
      await sleep(800);
      const face = () => app.evaluate(`(() => { const b = document.querySelector('#send-btn'); return { stop: b.classList.contains('stop'), label: b.getAttribute('aria-label'), placeholder: document.querySelector('#input').placeholder }; })()`);
      const empty = await face();
      check('chatbar: during a run with nothing typed the action is Stop, and the placeholder says Enter queues', empty.stop && empty.label === 'Stop' && /queue/i.test(empty.placeholder), empty);
      await app.fill('#input', 'And then list the files.');
      const typed = await face();
      check('chatbar: with something typed during a run the action queues it instead', !typed.stop && /queue/i.test(typed.label), typed);
      await app.key('Enter');
      await app.waitFor(`window.__oc_debug.queue().length > 0`, 5000, 'a queued message').catch(() => {});
      await sleep(300);
      check('chatbar: Enter queued the message, and the empty field shows Stop again', (await face()).stop && (await app.evaluate(`window.__oc_debug.queue().length`)) === 1);
      await bar('running-queue-light');
      await shot(app, 'chatbar-running-window-light');
      await app.waitIdle(180_000, false);
      await sleep(1500);
      const reply = await app.lastReply();
      const replies = await app.evaluate(`[...document.querySelectorAll('.msg.assistant')].map((e) => e.innerText.trim()).join(' | ')`);
      check('chatbar: the message went through and was answered, and the queued one after it', app.live ? replies.length > 20 && (await app.evaluate(`document.querySelectorAll('.msg.user').length`)) >= 2 : reply.length > 0, replies.slice(0, 200));
      await app.waitIdle(180_000, false).catch(() => {});
      await shot(app, 'chatbar-after-run-light');
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.permissionMode = 'bypass'; await window.oc.setConfig(c); })()`);
      await app.evaluate(`window.__oc_debug.context({ tokens: 23400, limit: 200000, threshold: 0.8, autoCompact: true })`);
    }

    // ---------- Midnight ----------
    if (want('theme')) {
      await app.evaluate(`document.getElementById('new-session-btn').click()`);
      await sleep(800);
      await seed(app);
      await seedCards(app);
      await enable(app, 'theme-midnight', true);
      await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#2f5bcc'`, 5000, 'the theme').catch(() => {});
      check('theme: the accent applies in light', (await app.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === '#2f5bcc');
      await sleep(800);
      const log = await dbg(app, 'log()');
      const reached = new Set(log.filter((e) => e.kind === 'event' && e.method === 'theme.changed').map((e) => e.view));
      check('theme: the rail mods were told (theme.changed)', ['context/main', 'tasks/main', 'environment/main'].every((k) => reached.has(k)), [...reached]);
      const railAccent = await frameEval(app, 'context', `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
      if (railAccent !== null) check('theme: a rail mod page uses its accent', railAccent === '#2f5bcc', railAccent);
      for (const scheme of ['light', 'dark']) {
        await setTheme(app, scheme);
        if (scheme === 'dark') check('theme: the accent applies in dark', (await app.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === '#5d90f5');
        await app.evaluate(`document.querySelector('.approval')?.scrollIntoView({ block: 'center' })`);
        await sleep(1000); // colour transitions settle
        await shot(app, `theme-window-${scheme}`);
        await app.screenshotOf(file(`theme-approval-${scheme}`), '.approval', 12).catch(() => {});
        await app.screenshotOf(file(`theme-diff-${scheme}`), '.tool:has(.diff), .diff', 12).catch(() => {});
        await app.screenshotOf(file(`theme-rail-${scheme}`), '#mod-rail', 0).catch(() => {});
        await app.click('#settings-btn');
        await sleep(900);
        await shot(app, `theme-settings-${scheme}`);
        await app.evaluate(`window.__oc_debug.settings.open('mods', { tab: 'themes' })`).catch(() => {});
        await sleep(500);
        await shot(app, `theme-settings-mods-${scheme}`);
        await app.click('#settings-close');
        await sleep(400);
      }
      // System scheme: with theme "system" the media query block applies
      await app.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = 'system'; await window.oc.setConfig(c); delete document.documentElement.dataset.theme; })()`);
      await sleep(800);
      check('theme: "System" on a dark system gets the dark values', (await app.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg-100').trim()`)) === '#181d28');
      await app.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await sleep(400);
      check('theme: "System" on a light system gets the light values', (await app.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg-100').trim()`)) === '#f6f8fc');
      await setTheme(app, 'light');
      await enable(app, 'theme-midnight', false);
      check('theme off: the app\'s accent is back', (await app.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`)) === '#1f66c4');
    }

    // ---------- All three ----------
    if (want('all')) {
      await enable(app, 'theme-midnight', true);
      await app.evaluate(`window.__oc_debug.context({ tokens: 61000, limit: 200000, threshold: 0.8, autoCompact: true })`);
      for (const [scheme, bgv] of [['light', 'aurora'], ['dark', 'aurora'], ['dark', 'constellation'], ['light', 'grid'], ['dark', 'dusk']]) {
        await setTheme(app, scheme);
        await rpc(app, 'mods.setLayout', { background: `backgrounds/${bgv}`, backgroundDim: 0.82 });
        await sleep(1500);
        await shot(app, `all-${bgv}-${scheme}`);
        const r = await readability(app, file(`all-${bgv}-${scheme}`));
        check(`all three (${bgv}, ${scheme}): readable`, r.text >= 4.5 && r.muted >= 3, r);
      }
      await rpc(app, 'mods.setLayout', { background: null });
      await enable(app, 'theme-midnight', false);
      await setTheme(app, 'light');
    }

    // ---------- h-md at rail and tab width ----------
    if (want('md')) {
      const userMods = path.join(app.profile, 'home-config', 'mods');
      const sample = '## Retry\\n\\nThe loop now waits `backoffMs * 2 ** i` and [the notes](notes.html) say why (see [the guide](https://example.com/retry)).\\n\\n- [x] read the code\\n- [ ] change it\\n\\n```js\\nconst wait = (ms) => new Promise((r) => setTimeout(r, ms)); // 42\\n```\\n\\n| a | b |\\n| - | - |\\n| 1 | 2 |\\n\\n> quoted';
      const pg = (cls) => `<!doctype html><link rel="stylesheet" href="/@harness/harness.css">${cls === 'h-md' ? '<style>html,body{height:100%}body{overflow:auto;padding:16px}</style>' : ''}<div class="${cls}" id="md"></div><script src="/@harness/harness.js"></script><script>harness.ready.then(async () => { document.getElementById('md').innerHTML = (await harness.ui.markdown('${sample}')).html; });</script>`;
      for (const [id, seat, cls] of [['md-rail', 'rail', 'h-md compact'], ['md-tab', 'tab', 'h-md']]) {
        const dir = path.join(userMods, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({ protocol: 1, id, name: id, version: '0.1.0', contributes: { views: [{ id: 'main', title: id, entry: 'p.html', seat, order: 5 }] } }));
        fs.writeFileSync(path.join(dir, 'p.html'), pg(cls));
      }
      // The registry picks new folders up through a debounced watcher: wait for both, not a fixed time.
      await app.waitFor(`window.oc.rpc('mods.list').then((l) => ['md-rail', 'md-tab'].every((k) => l.some((m) => m.key === k)))`, 15_000, 'the md mods to be listed');
      await rpc(app, 'mods.setEnabled', 'md-rail', true);
      await rpc(app, 'mods.setEnabled', 'md-tab', true);
      await sleep(1000);
      await app.evaluate(`window.__oc_debug.mods.open('md-tab/main')`);
      await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.mod.startsWith('md-') && v.hello).length === 2`, 8000, 'the two Markdown pages').catch(() => {});
      await sleep(800);
      // The Plan panel (bundled) shows a plan through h-md compact
      await dbg(app, `emit('plan.changed', { plan: { id: 'p1', title: 'Make the backoff configurable', status: 'proposed', markdown: '1. Add \`backoffMs\` to \`LoginOptions\`\\n2. Use it in the retry loop\\n3. Fake timers in the test\\n\\n\`\`\`ts\\nawait sleep(opts.backoffMs * 2 ** i);\\n\`\`\`' } })`);
      await sleep(800);
      for (const scheme of ['light', 'dark']) {
        await setTheme(app, scheme);
        await app.screenshotOf(file(`md-rail-${scheme}`), '.rail-section[data-view="md-rail/main"]', 0).catch(() => {});
        await app.screenshotOf(file(`md-plan-${scheme}`), '.rail-section[data-view="plan/main"]', 0).catch(() => {});
        await shot(app, `md-tab-${scheme}`);
      }
      await setTheme(app, 'light');
      // A link inside the frame (through the frame's own DevTools target). Only a relative one is clicked: an http(s)
      // link would open the real default browser, and Copy would overwrite the real clipboard; test/modkit.js covers both.
      const nav = await frameEval(app, 'md-tab', `(() => { const before = location.href; document.querySelector('.h-md a[href="notes.html"]').click(); return location.href === before; })()`);
      if (nav === null) console.log('skip h-md link check in the frame: no DevTools target for it');
      else check('h-md in the app: a link click does not navigate the frame', nav === true);
    }
  } catch (err) {
    check('no exception', false, String((err && err.stack) || err));
  } finally {
    const lines = app.console.filter((l) => /\[(error|exception)\]/.test(l));
    if (lines.length) console.log('console:\n' + lines.slice(-15).join('\n'));
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})();
