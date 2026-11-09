// Live check of the app's palette in the real window, in light and in dark: the page, the rail and the sidebar are
// the neutral greys of the tokens, the user's bubble is its grey, a default button is white (or the raised grey in
// dark) with a hairline and the button that confirms is a grey fill with the text colour, a switch that is on is
// blue, the spinner is neutral, and nothing visible in the window or in Settings is the old terracotta. Then the
// bundled Paper theme brings the warm page and the terracotta button back, and turning it off takes them away.
// Run: npm run build && node test/live/palette.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-palette-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();

// The expected values, as rgb() triples
const WANT = {
  light: { page: [255, 255, 255], sidebar: [239, 239, 239], bubble: [243, 243, 243], raised: [255, 255, 255], fill: [233, 233, 233], text: [25, 25, 25], switchOn: [39, 125, 226] },
  dark: { page: [24, 24, 24], sidebar: [36, 36, 36], bubble: [36, 36, 36], raised: [29, 29, 29], fill: [51, 51, 51], text: [240, 240, 240], switchOn: [65, 108, 217] },
};
// 0.4.0's terracotta, its hover shades and its light text tint
const TERRACOTTA = [
  [217, 119, 87],
  [198, 97, 63],
  [224, 138, 108],
];

/** The colours of what is on screen: every visible element's background, text, borders and SVG paint. */
const READ = `(() => {
  const rgb = (s) => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(s || ''); return m ? { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null; };
  const css = (sel, prop, pseudo) => { const e = document.querySelector(sel); return e ? rgb(getComputedStyle(e, pseudo || null)[prop]) : null; };
  const all = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const props = ['backgroundColor', 'color', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'fill', 'stroke'];
    for (const p of props) {
      if (p.startsWith('border') && cs[p.replace('Color', 'Width')] === '0px') continue;
      if ((p === 'color') && !el.childNodes.length) continue;
      const v = rgb(cs[p]);
      if (v && v.a > 0) all.push({ el: (el.id ? '#' + el.id : el.tagName.toLowerCase()) + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).join('.') : ''), p, c: v.c });
    }
  }
  return {
    page: css('.main', 'backgroundColor'),
    rail: css('#mod-rail', 'backgroundColor'),
    railShown: !!document.querySelector('#mod-rail') && document.querySelector('#mod-rail').getClientRects().length > 0,
    sidebar: css('.sidebar', 'backgroundColor'),
    bubble: css('.msg.user .bubble', 'backgroundColor'),
    deny: css('.approval .prompt-foot .btn:not(.primary)', 'backgroundColor'),
    denyText: css('.approval .prompt-foot .btn:not(.primary)', 'color'),
    answer: css('.approval .split-btn', 'backgroundColor'),
    answerText: css('.approval .split-btn', 'color'),
    btn: (() => { const e = [...document.querySelectorAll('#settings .btn:not(.primary):not(.danger)')].find((x) => x.getClientRects().length); return e ? { bg: rgb(getComputedStyle(e).backgroundColor), border: rgb(getComputedStyle(e).borderTopColor), text: rgb(getComputedStyle(e).color) } : null; })(),
    spinner: css('.status-line .spinner', 'borderTopColor'),
    toolSpin: css('.tool-status.spin', 'borderTopColor', '::after'),
    mark: (() => { const r = document.querySelector('.model-mark .brand-mark rect'); return r ? rgb(getComputedStyle(r).fill) : null; })(),
    all,
  };
})()`;

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1);
const grey = (c) => !!c && Math.max(...c) - Math.min(...c) <= 2;
const blue = (c) => !!c && c[2] > c[0] + 60 && c[2] > c[1] + 30;
const terracotta = (all) => all.filter((x) => TERRACOTTA.some((t) => same(x.c, t)));

async function setTheme(app, scheme) {
  await app.evaluate(`(async () => { const c = await window.oc.getConfig(); c.theme = ${JSON.stringify(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${JSON.stringify(scheme)}; })()`);
  await sleep(900); // colour transitions settle
}

(async () => {
  const app = await launch({ mock: true, mode: 'ask', scale: 1, config: { theme: 'light' } });
  try {
    // A conversation: the user's bubble, a reply, a tool row still running and an approval card waiting
    await app.evaluate(`(() => {
      window.__oc_debug.user('Can you make the retry backoff configurable?');
      window.__oc_debug.renderMarkdown('Sure. The retry loop in \`src/auth/login.ts\` waits a fixed **3 seconds**; see [the docs](https://example.com).');
      const e = window.__oc_debug.emit;
      e({ type: 'tool_start', id: 'b1', name: 'bash', args: { command: 'npm test' } });
      e({ type: 'approval_request', id: 'ap-1', name: 'bash', detail: 'npm test', mode: 'ask', alwaysLabel: 'Allow npm for this session', projectLabel: 'Always allow npm in this project' });
    })()`);
    await app.waitFor(`Boolean(document.querySelector('.approval .btn.primary'))`, 10_000, 'the approval card');
    await app.waitFor(`window.__oc_debug.mods.views().filter((v) => v.seat === 'rail' && !v.collapsed).every((v) => v.hello)`, 30_000, 'the rail mods').catch(() => {});
    await app.evaluate(`(() => { const r = document.querySelector('#rail-toggle'); if (r && !r.hidden && r.getAttribute('aria-pressed') !== 'true') r.click(); })()`);

    for (const scheme of ['light', 'dark']) {
      const W = WANT[scheme];
      await setTheme(app, scheme);
      await app.evaluate(`document.activeElement && document.activeElement.blur()`);
      const r = await app.evaluate(READ);
      await app.screenshot(path.join(SHOTS, `palette-window-${scheme}.png`));
      check(`${scheme}: the transcript's page is ${W.page}`, same(r.page && r.page.c, W.page), r.page);
      check(`${scheme}: the rail is on the page colour`, r.railShown && same(r.rail && r.rail.c, W.page), { shown: r.railShown, rail: r.rail });
      check(`${scheme}: the sidebar is ${W.sidebar}`, same(r.sidebar && r.sidebar.c, W.sidebar), r.sidebar);
      check(`${scheme}: the user's bubble is ${W.bubble}`, same(r.bubble && r.bubble.c, W.bubble), r.bubble);
      check(`${scheme}: the approval card's Deny is the quiet grey fill (${W.fill}) with the text colour`, same(r.deny && r.deny.c, W.fill) && same(r.denyText && r.denyText.c, W.text), { fill: r.deny, text: r.denyText });
      check(`${scheme}: its Allow once is inverted: the text colour as fill, the page as label`, same(r.answer && r.answer.c, W.text) && same(r.answerText && r.answerText.c, W.page), { fill: r.answer, text: r.answerText });
      check(`${scheme}: the spinners are neutral`, grey(r.spinner && r.spinner.c) && grey(r.toolSpin && r.toolSpin.c), { status: r.spinner, tool: r.toolSpin });
      check(`${scheme}: the mark beside the model name is neutral`, grey(r.mark && r.mark.c), r.mark);
      const hot = terracotta(r.all);
      check(`${scheme}: nothing visible in the window is the old terracotta`, r.all.length > 200 && hot.length === 0, { read: r.all.length, hot: hot.slice(0, 8) });

      // Settings: a switch that is on is blue; no terracotta on any of the pages
      await app.click('#settings-btn');
      await app.waitFor(`document.querySelector('#settings').open`, 10_000, 'Settings');
      for (const s of ['general', 'appearance', 'mods', 'skills', 'permissions', 'model']) {
        await app.click(`#sp-nav-${s}`);
        await sleep(500);
        const p = await app.evaluate(READ);
        const h = terracotta(p.all);
        check(`${scheme}: Settings → ${s}: nothing visible is the old terracotta`, p.all.length > 100 && h.length === 0, { read: p.all.length, hot: h.slice(0, 8) });
        if (s === 'general') check(`${scheme}: a default button is the raised surface with a neutral hairline and the text colour`, p.btn && same(p.btn.bg && p.btn.bg.c, W.raised) && grey(p.btn.border && p.btn.border.c) && same(p.btn.text && p.btn.text.c, W.text), p.btn);
        if (s === 'mods') {
          await app.screenshot(path.join(SHOTS, `palette-settings-mods-${scheme}.png`));
          const sw = await app.evaluate(`(() => { const e = [...document.querySelectorAll('#settings input.switch:checked')].find((x) => x.getClientRects().length); return e ? getComputedStyle(e).backgroundColor : null; })()`);
          const c = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(sw || '');
          const rgb = c ? [+c[1], +c[2], +c[3]] : null;
          check(`${scheme}: a switch that is on is blue (${W.switchOn})`, blue(rgb) && same(rgb, W.switchOn), sw);
        }
      }
      await app.click('#settings-close');
      await sleep(400);
    }

    // The Paper theme: the warm page and the terracotta button come back, and go again when it is off
    await setTheme(app, 'light');
    const mods = await app.evaluate(`window.oc.rpc('mods.list')`);
    const paper = mods.find((m) => m.id === 'theme-paper');
    check('Paper: bundled, off by default', paper && paper.state === 'off', paper && paper.state);
    await app.evaluate(`window.oc.rpc('mods.setEnabled', 'theme-paper', true)`);
    await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--bg-100').trim() === '#faf9f5'`, 10_000, 'the Paper theme').catch(() => {});
    await sleep(900);
    for (const scheme of ['light', 'dark']) {
      await setTheme(app, scheme);
      const p = await app.evaluate(READ);
      await app.screenshot(path.join(SHOTS, `palette-paper-${scheme}.png`));
      const page = scheme === 'light' ? [250, 249, 245] : [38, 38, 36];
      check(`Paper ${scheme}: the warm page is back`, same(p.page && p.page.c, page), p.page);
      check(`Paper ${scheme}: Allow once is terracotta with a white label, Deny is not`, same(p.answer && p.answer.c, TERRACOTTA[0]) && same(p.answerText && p.answerText.c, [255, 255, 255]) && !!p.deny && !same(p.deny.c, TERRACOTTA[0]), { answer: p.answer, text: p.answerText, deny: p.deny });
      check(`Paper ${scheme}: the mark is terracotta again`, same(p.mark && p.mark.c, TERRACOTTA[0]), p.mark);
      check(`Paper ${scheme}: the scan for terracotta finds it (so the scans above can see it)`, terracotta(p.all).length >= 3, terracotta(p.all).length);
    }
    await setTheme(app, 'light');
    await app.evaluate(`window.oc.rpc('mods.setEnabled', 'theme-paper', false)`);
    await app.waitFor(`!document.querySelector('style[data-mod="theme-paper"]')`, 10_000, 'the Paper theme to go').catch(() => {});
    await sleep(900);
    const off = await app.evaluate(READ);
    check('Paper off: the white page and the inverted Allow once are back', same(off.page && off.page.c, WANT.light.page) && same(off.answer && off.answer.c, WANT.light.text), { page: off.page, answer: off.answer });

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
