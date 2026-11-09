// Live check of the bundled Glass theme in the real window, in light and in dark. It is bundled and off by default.
// Turned on: the sidebar, the side pane and the rail, the chat bar, the approval card, the model menu and the Settings
// dialog are glass (a backdrop filter, and a background that lets what is behind it through), the reading column stays
// the page colour and opaque, and the chat bar floats over the transcript's last lines with the last message still
// whole when scrolled to the bottom. Text keeps its contrast on every glass surface, measured from the pixels of a
// screenshot (a strip of bare surface just inside each one's left edge, and the transcript's margins): text-100 at
// least 7:1 and text-400 at least 4.5:1 over the theme's own canvas; with the Starfield behind the window, 4.5:1 and
// 3:1 at the default Dim and at half of it, for all but the odd pixel (a star behind glass). Turning the background
// off, and the theme off, restores the window pixel for pixel; the Theme tab shows Glass in use.
// Screenshots: the empty page, a conversation, the menu, Settings, the Starfield and Aurora, in both schemes.
// Run: npm run build && node test/live/glass.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-glass-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const file = (name) => path.join(SHOTS, `${name}.png`);
const rpc = (app, method, ...args) => app.evaluate(`window.oc.rpc(${JSON.stringify(method)}, ...${JSON.stringify(args)})`);

async function setTheme(app, scheme) {
  await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = ${JSON.stringify(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${JSON.stringify(scheme)}; })()`);
  await sleep(900); // colour transitions settle
}

async function enable(app, id, on) {
  await rpc(app, 'mods.setEnabled', id, on);
  await app.waitFor(`${on ? '' : '!'}document.querySelector('style[data-mod=${JSON.stringify(id)}]')`, 10_000, `the ${id} styles ${on ? 'to apply' : 'to go'}`).catch(() => {});
  await sleep(900);
}

/** Decodes a PNG screenshot (CDP writes 8-bit RGB, colour type 2; RGBA is type 6) to RGBA pixels. */
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

/** Pixels that differ between two screenshots (of the same size). */
function pixelDiff(fa, fb) {
  const a = pixels(fa);
  const b = pixels(fb);
  if (a.w !== b.w || a.h !== b.h) return Infinity;
  let n = 0;
  for (let i = 0; i < a.out.length; i += 4) if (a.out[i] !== b.out[i] || a.out[i + 1] !== b.out[i + 1] || a.out[i + 2] !== b.out[i + 2]) n++;
  return n;
}

const lin = (c) => {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

/**
 * The text colours in effect and the strips of bare surface to sample (CSS pixels; the screenshots are at scale 1):
 * just inside the left edge of each glass surface, where every one of them keeps at least 8px of padding, clear of
 * its rounded corners, and the transcript's margin beside the reading column.
 */
const GEO = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgb = (v) => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = v; probe.fillRect(0, 0, 1, 1); return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)]; };
  const box = (sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, r: r.right, b: r.bottom }; };
  const strips = {};
  const strip = (name, sel, inset, width, corner) => { const b = box(sel); if (b) strips[name] = { x0: b.x + inset, x1: b.x + inset + width, y0: b.y + corner, y1: b.b - corner, step: 1 }; };
  strip('sidebar', '.sidebar', 2, 4, 3);
  strip('composer', '#composer', 2, 4, 20);
  strip('card', '.approval:not(.done)', 3, 10, 16);
  strip('menu', '.popover', 2, 2, 18);
  strip('pane', '.side-pane', 2, 4, 3);
  strip('rail', '#mod-rail', 2, 3, 3);
  strip('dialog-nav', '#settings[open] .sp-side', 2, 6, 18);
  strip('dialog-page', '#settings[open] .sp-content', 4, 20, 3);
  const wrap = box('.transcript-wrap');
  const col = box('#messages > *:not([hidden])');
  const comp = box('.composer-wrap');
  if (wrap && col && comp) strips.page = { x0: wrap.x + 6, x1: Math.max(wrap.x + 8, col.x - 6), y0: wrap.y + 50, y1: comp.y - 8, step: 9 };
  return { t100: rgb(cs.getPropertyValue('--text-100')), t400: rgb(cs.getPropertyValue('--text-400')), strips };
})()`;

/**
 * The contrast text would have on each named surface in the screenshot: the worst pixel, and the worst of all but
 * the lowest 2% (over a starfield a sample may land on a star). A pixel unlike both the one above and the one
 * below it is a hairline crossing the strip (a tab row's rule, a highlight), not the surface, and is left out.
 */
async function contrast(app, png, names) {
  const geo = await app.evaluate(GEO);
  const { w, out } = pixels(png);
  const px = (x, y) => {
    const i = (Math.round(y) * w + Math.round(x)) * 4;
    return [out[i], out[i + 1], out[i + 2]];
  };
  const result = {};
  for (const name of names) {
    const s = geo.strips[name];
    if (!s) {
      result[name] = null;
      continue;
    }
    const r100 = [];
    const r400 = [];
    for (let y = s.y0; y < s.y1; y += s.step === 9 ? 9 : 3) {
      for (let x = s.x0; x < s.x1; x += s.step) {
        const p = px(x, y);
        const l = lum(p);
        const above = lum(px(x, y - 2)) - l;
        const below = lum(px(x, y + 2)) - l;
        if (Math.abs(above) > 0.01 && Math.abs(below) > 0.01 && Math.sign(above) === Math.sign(below)) continue;
        r100.push(ratio(p, geo.t100));
        r400.push(ratio(p, geo.t400));
      }
    }
    r100.sort((a, b) => a - b);
    r400.sort((a, b) => a - b);
    const at = (arr, q) => Number((arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0).toFixed(2));
    result[name] = { n: r100.length, text: at(r100, 0), muted: at(r400, 0), text98: at(r100, 0.02), muted98: at(r400, 0.02) };
  }
  return result;
}

/** The glass surfaces' computed backgrounds and backdrop filters. */
const SURFACES = `(() => {
  const alpha = (c) => { const slash = /\\/\\s*([\\d.]+)\\s*\\)\\s*$/.exec(c); if (slash) return Number(slash[1]); const m = /rgba\\(([^)]+)\\)/.exec(c); return m ? Number(m[1].split(',')[3]) : 1; };
  const read = (sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const cs = getComputedStyle(e); return { alpha: alpha(cs.backgroundColor), blur: cs.backdropFilter !== 'none', bg: cs.backgroundColor }; };
  const dlg = document.querySelector('#settings');
  const back = dlg && dlg.open ? getComputedStyle(dlg, '::backdrop') : null;
  return {
    sidebar: read('.sidebar'), composer: read('#composer'), pane: read('.side-pane'), rail: read('#mod-rail'), card: read('.approval:not(.done)'), menu: read('.popover'),
    dialog: dlg && dlg.open ? read('#settings') : null, backdrop: back && { blur: back.backdropFilter !== 'none', alpha: alpha(back.backgroundColor) },
    page: read('.transcript-wrap'), main: read('.main'), canvas: getComputedStyle(document.documentElement).backgroundImage !== 'none',
  };
})()`;
const glass = (s) => !!s && s.blur && s.alpha < 1;

/** The chat bar over the transcript: how far it reaches into the scroll box, and where the last message ends against it. */
const OVERLAP = `(() => {
  const m = document.querySelector('#messages');
  const w = document.querySelector('.composer-wrap');
  const last = [...m.children].filter((e) => !e.hidden && e.id !== 'task-list').pop();
  const top = w.getBoundingClientRect().top;
  m.scrollTop = 0;
  const underAtTop = last.getBoundingClientRect().bottom > top;
  m.scrollTop = m.scrollHeight;
  return { overlap: Math.round(m.getBoundingClientRect().bottom - top), lastBelow: Math.round(last.getBoundingClientRect().bottom - top), underAtTop, scrollable: m.scrollHeight > m.clientHeight };
})()`;

/** A conversation without the model: a question, a reply with code, a table and a note, a tool row, an approval card. */
async function seed(app) {
  await app.evaluate(`(() => {
    window.__oc_debug.user('Can you make the retry backoff configurable and fix the flaky login test?');
    window.__oc_debug.renderMarkdown(${JSON.stringify(
      "Sure. The retry loop in `src/auth/login.ts` waits a fixed **3 seconds**; I'll take the delay from the options instead.\n\n" +
        '## What changes\n\n- `LoginOptions` gets `backoffMs` (default 500)\n- each retry waits `backoffMs * 2 ** attempt`\n- the test uses fake timers, so it no longer depends on the clock\n\n' +
        '```ts\nexport async function login(opts: LoginOptions) {\n  for (let i = 0; i < 3; i++) {\n    const res = await post("/login", opts); // retry on 503\n    if (res.ok) return res;\n    await sleep(opts.backoffMs * 2 ** i);\n  }\n}\n```\n\n' +
        '| Attempt | Wait |\n| --- | --- |\n| 1 | 500 ms |\n| 2 | 1 s |\n| 3 | 2 s |\n\n> Muted text, like this note, has to stay readable too.',
    )});
    const e = window.__oc_debug.emit;
    e({ type: 'tool_start', id: 'd1', name: 'edit_file', args: { path: 'src/auth/login.ts', old_string: '    await sleep(3000);\\n  }', new_string: '    await sleep(opts.backoffMs * 2 ** i);\\n  }' } });
    e({ type: 'tool_end', id: 'd1', name: 'edit_file', result: 'Edited src/auth/login.ts (+2 -1)', ok: true });
    e({ type: 'tool_start', id: 'b1', name: 'bash', args: { command: 'npm test -- test/auth/login.test.ts' } });
    e({ type: 'approval_request', id: 'ap-1', name: 'bash', detail: 'npm test -- test/auth/login.test.ts', mode: 'ask', alwaysLabel: 'Allow npm for this session', projectLabel: 'Always allow npm in this project' });
  })()`);
  await app.waitFor(`Boolean(document.querySelector('.approval .btn.primary'))`, 10_000, 'the approval card');
  await sleep(300);
}

const PANES = ['sidebar', 'composer', 'pane', 'rail', 'page'];
const readable = (r, names, text, muted, q = '') => names.every((n) => r[n] && r[n][`text${q}`] >= text && r[n][`muted${q}`] >= muted);

(async () => {
  const app = await launch({ mock: true, mode: 'ask', scale: 1, config: { theme: 'light' } });
  try {
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'rail' && !v.collapsed).every((v) => v.hello)`, 30_000, 'the rail mods').catch(() => {});
    await app.evaluate(`(() => { const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') !== 'true') r.click(); })()`);
    await sleep(400);
    const blur = () => app.evaluate(`document.activeElement && document.activeElement.blur()`);
    const shot = async (name) => {
      await blur();
      await app.screenshot(file(name));
    };

    // ---------- Bundled, off by default ----------
    const mods = await rpc(app, 'mods.list');
    const me = mods.find((m) => m.id === 'theme-glass');
    check('Glass: bundled, off by default, styles only, no permissions', me && me.scope === 'bundled' && me.state === 'off' && me.manifest.contributes.styles.join() === 'theme.css' && !me.manifest.contributes.views && (me.manifest.permissions ?? []).length === 0 && me.granted.length === 0, me && { state: me.state, scope: me.scope });
    const before = await app.evaluate(SURFACES);
    check('off: the sidebar and the chat bar are opaque, nothing is blurred, the canvas is plain', before.sidebar.alpha === 1 && !before.sidebar.blur && before.composer.alpha === 1 && !before.composer.blur && !before.canvas, before);

    // ---------- On: the empty page ----------
    await enable(app, 'theme-glass', true);
    for (const scheme of ['light', 'dark']) {
      await setTheme(app, scheme);
      await shot(`glass-empty-${scheme}`);
      const r = await contrast(app, file(`glass-empty-${scheme}`), PANES);
      check(`${scheme} empty page: text 7:1 and muted text 4.5:1 on the sidebar, the chat bar, the side pane, the rail and the page`, readable(r, PANES, 7, 4.5), r);
    }

    // ---------- A conversation ----------
    await setTheme(app, 'light');
    await seed(app);
    for (const scheme of ['light', 'dark']) {
      await setTheme(app, scheme);
      await shot(`glass-conversation-${scheme}`);
      const s = await app.evaluate(SURFACES);
      check(`${scheme}: the sidebar, the chat bar, the side pane, the rail and the approval card are glass (a backdrop filter, a background that lets what is behind through)`, glass(s.sidebar) && glass(s.composer) && glass(s.pane) && glass(s.rail) && glass(s.card), s);
      check(`${scheme}: the reading column is the page colour and opaque, the window's own surface is clear, the canvas is the theme's`, s.page.alpha === 1 && s.main.alpha === 0 && s.canvas, { page: s.page, main: s.main, canvas: s.canvas });
      const r = await contrast(app, file(`glass-conversation-${scheme}`), [...PANES, 'card']);
      check(`${scheme} conversation: text 7:1 and muted text 4.5:1 on every glass surface and in the margins of the page`, readable(r, [...PANES, 'card'], 7, 4.5), r);
      const o = await app.evaluate(OVERLAP);
      check(`${scheme}: the chat bar floats over the transcript (${o.overlap}px), text passes under it, and the last message is whole when scrolled to the bottom`, o.scrollable && o.overlap >= 48 && o.underAtTop && o.lastBelow <= 0, o);
    }

    // The model menu, in dark (the scheme in which a menu's tint shows most)
    await app.click('#model-btn');
    await app.waitFor(`Boolean(document.querySelector('.popover'))`, 5000, 'the model menu');
    await sleep(400);
    await app.screenshot(file('glass-menu-dark'));
    const m = await app.evaluate(SURFACES);
    const mr = await contrast(app, file('glass-menu-dark'), ['menu']);
    check('dark: the model menu is glass, and text on it keeps 7:1 (muted 4.5:1)', glass(m.menu) && readable(mr, ['menu'], 7, 4.5), { menu: m.menu, ...mr });
    await app.key('Escape');
    await sleep(300);

    // Settings: the dialog is glass over a blurred, dimmed window; the Theme tab shows Glass in use
    for (const scheme of ['light', 'dark']) {
      await setTheme(app, scheme);
      await app.click('#settings-btn');
      await app.waitFor(`document.querySelector('#settings').open`, 10_000, 'Settings');
      await app.click('#sp-nav-mods');
      await sleep(300);
      await app.evaluate(`document.querySelector('#sp-modtab-themes')?.click()`);
      await sleep(400);
      await app.screenshot(file(`glass-settings-${scheme}`));
      const s = await app.evaluate(SURFACES);
      check(`${scheme}: the Settings dialog is glass, over a backdrop that dims and blurs the window`, glass(s.dialog) && s.backdrop && s.backdrop.blur && s.backdrop.alpha > 0 && s.backdrop.alpha < 1, { dialog: s.dialog, backdrop: s.backdrop });
      const r = await contrast(app, file(`glass-settings-${scheme}`), ['dialog-nav', 'dialog-page']);
      check(`${scheme}: text keeps 7:1 (muted 4.5:1) on the dialog's navigation and its page`, readable(r, ['dialog-nav', 'dialog-page'], 7, 4.5), r);
      if (scheme === 'light') {
        const t = await app.evaluate(`window.__oc_debug.looks.state('themes')`);
        const inUse = await app.evaluate(`[...document.querySelectorAll('.sp-look-tab[data-subtab="themes"] .sp-look-card.current .sp-look-name')].map((e) => e.textContent)`);
        check('the Theme tab shows Glass in use, after Default and before Midnight and Paper, with no switches', t && t.current === 'theme-glass' && !t.previewing && JSON.stringify(t.versions) === JSON.stringify([null, 'theme-glass', 'theme-midnight', 'theme-paper']) && JSON.stringify(inUse) === JSON.stringify(['Glass theme']) && !(await app.exists('.sp-look-tab[data-subtab="themes"] input.switch')), { t, inUse });
      }
      await app.click('#settings-close');
      await sleep(400);
    }

    // ---------- Still life: the approval answered, the tool ended, so nothing spins; off and on again is pixel-exact ----------
    await setTheme(app, 'light');
    await app.evaluate(`(() => { const e = window.__oc_debug.emit; e({ type: 'approval_resolved', id: 'ap-1', ok: true, scope: 'once' }); e({ type: 'tool_end', id: 'b1', name: 'bash', result: 'PASS', ok: true }); })()`);
    await sleep(600);
    await app.evaluate(`document.querySelector('#messages').scrollTop = 0`);
    await shot('glass-still');
    await enable(app, 'theme-glass', false);
    await shot('off-still');
    const off = await app.evaluate(SURFACES);
    check('off again: the sidebar and the chat bar are opaque and unblurred, the canvas is plain', off.sidebar.alpha === 1 && !off.sidebar.blur && off.composer.alpha === 1 && !off.composer.blur && !off.canvas && off.main.alpha === 1, off);
    await enable(app, 'theme-glass', true);
    await shot('glass-still-again');
    const again = pixelDiff(file('glass-still'), file('glass-still-again'));
    check('on again: the window is as it was (pixel diff)', again < 2000, `${again} pixels differ`);

    // ---------- Behind a background: the Starfield at the default Dim and at half, Aurora ----------
    // A built-in background is used as it is (no switch, no approval)
    await rpc(app, 'mods.setLayout', { background: 'hyperspace/starfield', backgroundDim: 0.82 });
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'hyperspace/starfield' && v.hello)`, 15_000, 'the Starfield').catch(() => {});
    await sleep(1500);
    for (const scheme of ['light', 'dark']) {
      await setTheme(app, scheme);
      await shot(`glass-starfield-${scheme}`);
      const s = await app.evaluate(SURFACES);
      check(`${scheme} Starfield: the panes stay glass, and the transcript lets the background through at the Dim chosen (as without the theme)`, glass(s.sidebar) && glass(s.composer) && glass(s.pane) && glass(s.rail) && s.page.alpha === 0 && Math.abs(s.main.alpha - 0.82) < 0.02, { sidebar: s.sidebar, composer: s.composer, page: s.page, main: s.main });
      const r = await contrast(app, file(`glass-starfield-${scheme}`), PANES);
      check(`${scheme} Starfield at Dim 0.82: text 4.5:1 and muted text 3:1 on every pane, all but the odd pixel`, readable(r, PANES, 4.5, 3, '98'), r);
    }
    await rpc(app, 'mods.setLayout', { background: 'hyperspace/starfield', backgroundDim: 0.5 });
    await sleep(900);
    await shot('glass-starfield-dark-dim50');
    const half = await contrast(app, file('glass-starfield-dark-dim50'), PANES);
    check('dark Starfield at Dim 0.5: text 4.5:1 and muted text 3:1 on every pane, all but the odd pixel', readable(half, PANES, 4.5, 3, '98'), half);
    await app.click('#model-btn');
    await sleep(400);
    await app.screenshot(file('glass-starfield-dark-dim50-menu'));
    await app.key('Escape');
    await sleep(200);
    await rpc(app, 'mods.setLayout', { background: 'backgrounds/aurora', backgroundDim: 0.6 });
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'backgrounds/aurora' && v.hello)`, 15_000, 'Aurora').catch(() => {});
    await sleep(1500);
    await shot('glass-aurora-dark');
    await setTheme(app, 'light');
    await shot('glass-aurora-light');
    const au = await contrast(app, file('glass-aurora-light'), PANES);
    check('light Aurora at Dim 0.6: text 4.5:1 and muted text 3:1 on every pane, all but the odd pixel', readable(au, PANES, 4.5, 3, '98'), au);
    await rpc(app, 'mods.setLayout', { background: null, backgroundDim: 0.82 });
    await sleep(1200);
    await app.evaluate(`document.querySelector('#messages').scrollTop = 0`);
    await shot('glass-still-after-bg');
    const back = pixelDiff(file('glass-still'), file('glass-still-after-bg'));
    check('background off: the window is as it was before one was on (pixel diff)', back < 2000 && !(await app.evaluate(`document.documentElement.classList.contains('mod-bg')`)), `${back} pixels differ`);

    // ---------- Off ----------
    await enable(app, 'theme-glass', false);
    await shot('off-still-end');
    const gone = pixelDiff(file('off-still'), file('off-still-end'));
    check('theme off: the window is as it was with the theme off (pixel diff)', gone < 2000, `${gone} pixels differ`);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    console.log(`screenshots: ${SHOTS}`);
  } finally {
    await app.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
