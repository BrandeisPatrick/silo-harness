// Live check for images in replies, against the real API in bypass mode: (a) show a PNG from the project with a
// caption, (b) write an SVG and show it, (c) screenshot a page in the browser and put the screenshot in the reply,
// (d) Markdown images through the debug hook (data URL, local path, missing path, https URL). Then the lightbox,
// and a relaunch on the same profile shows the same images. Screenshots in light and dark.
// Run: npm run build && ANTHROPIC_API_KEY=… node test/live/images.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { launch, checker, sleep } = require('./rig.js');

// A 240×240 PNG logo: an accent disc with a ring, drawn here so the test needs no fixture file.
function logoPng(size = 240) {
  const crc32 = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c + 0.5, y - c + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      let rgba = [0, 0, 0, 0];
      if (d < size * 0.3) rgba = [217, 119, 87, 255];
      else if (d > size * 0.36 && d < size * 0.44) rgba = [61, 61, 58, 255];
      raw.set(rgba, o);
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const { check, done } = checker();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-images-profile-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-images-project-'));
  const logo = logoPng();
  fs.writeFileSync(path.join(project, 'logo.png'), logo);
  fs.writeFileSync(path.join(project, 'local.png'), logoPng(96));

  /** Marks the last element matching `selector` so a screenshot can find it. */
  const last = async (app, selector) => {
    await app.evaluate(`(() => { document.querySelectorAll('[data-shot]').forEach((e) => e.removeAttribute('data-shot')); const e = [...document.querySelectorAll(${JSON.stringify(selector)})].pop(); if (e) e.dataset.shot = '1'; })()`);
    return '[data-shot]';
  };
  const both = async (app, name, selector, margin = 24) => {
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(250);
      const file = path.join(shots, `${name}-${theme}.png`);
      if (selector) await app.screenshotOf(file, selector, margin);
      else await app.screenshot(file);
    }
    await app.evaluate(`document.documentElement.dataset.theme = ''`);
  };
  const imagesLoaded = (app) => app.waitFor(`[...document.querySelectorAll('.reply-image img, img.md-img')].every((i) => i.complete && i.naturalWidth > 0)`, 15_000, 'images to load');

  let app = await launch({ mode: 'bypass', profile, project });
  let figuresBefore = [];
  try {
    if (!app.live) console.log('NOTE: no ANTHROPIC_API_KEY: the mock model cannot call tools, so (a)–(c) are skipped');
    if (app.live) {
      // (a) a PNG in the project folder, with a caption
      await app.send('Show me logo.png with the caption "Our logo". Use the show_image tool, then reply with one short sentence.');
      await app.waitIdle(120_000);
      await imagesLoaded(app);
      const fig = await app.evaluate(`(() => { const f = document.querySelector('.reply-image'); if (!f) return null; const r = f.querySelector('.reply-image-frame').getBoundingClientRect(); return { cap: f.querySelector('figcaption')?.innerText, w: r.width, h: r.height, src: f.querySelector('img').getAttribute('src') }; })()`);
      check('(a) a figure with the caption', fig && fig.cap === 'Our logo', fig);
      check('(a) served from the session store', fig && /^artifact:\/\/view\/[\w-]+\/images\/img-1\.png$/.test(fig.src), fig && fig.src);
      check('(a) not scaled up: 240 px box (plus the hairline)', fig && Math.round(fig.w) === 242 && Math.round(fig.h) === 242, fig);
      check('(a) no tool row for the call', (await app.count('.tool[data-tool="show_image"]:not([hidden])')) === 0);
      const order = await app.evaluate(`[...document.querySelectorAll('#messages > *')].filter((e) => !e.hidden && e.id !== 'empty-state').map((e) => e.classList.contains('reply-images') ? 'image' : e.classList.contains('msg') ? e.className.split(' ')[1] : e.className.split(' ')[0])`);
      check('(a) the figure sits after the user message, in the reply', order[0] === 'user' && order.includes('image') && order.indexOf('image') > 0, order);
      await both(app, 'a-logo', '.reply-images', 40);
      // hover toolbar
      await app.evaluate(`document.querySelector('.reply-image-tools').style.opacity = '1'`);
      await both(app, 'a-logo-toolbar', '.reply-images', 40);
      await app.evaluate(`document.querySelector('.reply-image-tools').style.opacity = ''`);
      // lightbox
      await app.evaluate(`document.querySelector('.reply-image-frame').click()`);
      await sleep(300);
      const lb = await app.evaluate(`({ open: document.getElementById('lightbox').open, src: document.getElementById('lightbox-img').getAttribute('src'), cap: document.getElementById('lightbox-caption').innerText })`);
      check('(a) a click opens the lightbox with the caption', lb.open && /images\/img-1\.png$/.test(lb.src) && lb.cap === 'Our logo', lb);
      await both(app, 'a-lightbox');
      await app.evaluate(`document.getElementById('lightbox').close()`);

      // (b) an SVG the model writes
      await app.send('Write a small SVG file named circles.svg (width 300, height 120) with three coloured circles in a row, then show it to me with show_image. Keep your reply to one sentence.');
      await app.waitIdle(180_000);
      await imagesLoaded(app);
      const svgFig = await app.evaluate(`(() => { const f = [...document.querySelectorAll('.reply-image')].pop(); return f ? { src: f.querySelector('img').getAttribute('src'), w: f.querySelector('img').naturalWidth } : null; })()`);
      check('(b) the SVG is shown inline', svgFig && /images\/img-2\.svg$/.test(svgFig.src) && svgFig.w > 0, svgFig);
      check('(b) circles.svg was written', fs.existsSync(path.join(project, 'circles.svg')));
      await both(app, 'b-svg', await last(app, '.reply-images'), 40);

      // (c) a browser screenshot, put in the reply
      await app.send('Open https://example.com in the browser, take a screenshot, and include the screenshot in your answer with show_image. One sentence is enough.');
      await app.waitIdle(240_000);
      await imagesLoaded(app);
      // The finished turn is folded under its "Worked for" line: open it, so its tool rows are laid out
      await app.unfold();
      // The browser calls fold into one line (Tool activity: Summary), which carries the screenshot's thumbnail;
      // opened, it shows the screenshot's own row
      // (the row that carries a picture: in a hidden window a first attempt can fail, and the model then takes another)
      const folded = await app.evaluate(`(() => { const g = [...document.querySelectorAll('.tool[data-tool="browser_screenshot"]')].find((r) => r.querySelector(':scope > summary img.tool-thumb'))?.closest('.tool-group'); if (!g) return null; const t = g.querySelector(':scope > summary .group-thumbs img.tool-thumb'); return { open: g.open, thumb: Boolean(t), thumbH: t ? t.getBoundingClientRect().height : 0 }; })()`);
      check('(c) the folded line shows the screenshot as a 20 px thumbnail', !folded || (!folded.open && folded.thumb && Math.round(folded.thumbH) === 20), folded);
      await app.evaluate(`[...document.querySelectorAll('.tool[data-tool="browser_screenshot"]')].find((r) => r.querySelector(':scope > summary img.tool-thumb'))?.closest('.tool-group')?.setAttribute('open', '')`);
      const shot = await app.evaluate(`(() => { const f = [...document.querySelectorAll('.reply-image')].pop(); const thumb = document.querySelector('.tool[data-tool="browser_screenshot"] > summary img.tool-thumb'); return { fig: f && f.querySelector('img').getAttribute('src'), thumb: Boolean(thumb), thumbH: thumb ? thumb.getBoundingClientRect().height : 0 }; })()`);
      check('(c) the screenshot is in the reply', shot.fig && /images\/img-3\.png$/.test(shot.fig), shot);
      check('(c) its tool row has a 20 px thumbnail', shot.thumb && Math.round(shot.thumbH) === 20, shot);
      // collapse the row to show the thumbnail on its summary line
      await app.evaluate(`document.querySelectorAll('.tool[data-tool="browser_screenshot"]').forEach((t) => (t.open = false))`);
      await both(app, 'c-screenshot', '#messages', 0);
      await app.evaluate(`document.querySelector('.tool[data-tool="browser_screenshot"] > summary img.tool-thumb').click()`);
      await sleep(300);
      check('(c) the thumbnail opens the lightbox', await app.evaluate(`document.getElementById('lightbox').open && document.getElementById('lightbox-img').src.startsWith('data:image/')`));
      check('(c) without toggling the row', await app.evaluate(`!document.querySelector('.tool[data-tool="browser_screenshot"]').open`));
      await app.evaluate(`document.getElementById('lightbox').close()`);
    }

    // (d) Markdown images through the debug hook
    const dataUrl = `data:image/png;base64,${logoPng(48).toString('base64')}`;
    const md = [
      'Here are the Markdown images:',
      '',
      `A data URL ![tiny logo](${dataUrl}) inline.`,
      '',
      'A local file: ![local logo](./local.png)',
      '',
      'A missing one: ![ghost](./nope/ghost.png)',
      '',
      'And a remote one: ![example](https://example.com/pic.png)',
    ].join('\n');
    await app.evaluate(`window.__oc_debug.renderMarkdown(${JSON.stringify(md)})`);
    await app.waitFor(`!document.querySelector('.md-img-pending')`, 10_000, 'placeholders to settle');
    await imagesLoaded(app);
    const mdState = await app.evaluate(`(() => { const m = [...document.querySelectorAll('.msg.assistant')].pop(); return { data: m.querySelector('img.md-img[src^="data:"]') !== null, local: [...m.querySelectorAll('img.md-img')].some((i) => i.src.startsWith('artifact://view/_local/')), missing: m.querySelector('.md-img-missing')?.innerText, link: m.querySelector('a.md-img-link')?.innerText, href: m.querySelector('a.md-img-link')?.getAttribute('href'), remoteImg: [...m.querySelectorAll('img')].some((i) => /^https?:/.test(i.src)) }; })()`);
    check('(d) the data URL renders as an image', mdState.data, mdState);
    check('(d) the local path is resolved to an artifact URL', mdState.local, mdState);
    check('(d) the missing path is a quiet chip', /image not found: ghost/.test(mdState.missing || ''), mdState.missing);
    check('(d) the https image is a link chip, never loaded', /image: example/.test(mdState.link || '') && mdState.href === 'https://example.com/pic.png' && !mdState.remoteImg, mdState);
    await app.evaluate(`document.getElementById('messages').scrollTop = 1e9`);
    await both(app, 'd-markdown');

    // (e) a group row of MCP calls that returned images: at most three thumbnails, then "+N"
    const thumbUrl = `data:image/png;base64,${logoPng(40).toString('base64')}`;
    await app.evaluate(`(() => { for (let i = 0; i < 5; i++) { const id = 'g' + i; window.__oc_debug.emit({ type: 'tool_start', id, name: 'mcp__figma__get_image', args: { node: 'frame ' + i } }); window.__oc_debug.emit({ type: 'tool_end', id, name: 'mcp__figma__get_image', result: 'image', ok: true, image: ${JSON.stringify(thumbUrl)}, durationMs: 40 }); } })()`);
    await sleep(300);
    const group = await app.evaluate(`(() => { const g = [...document.querySelectorAll('.tool-group')].pop(); if (!g) return null; return { thumbs: g.querySelectorAll(':scope > summary .group-thumbs img.tool-thumb').length, more: g.querySelector(':scope > summary .thumb-more')?.innerText, open: g.open }; })()`);
    check('(e) a group row shows three thumbnails and +2', group && group.thumbs === 3 && group.more === '+2', group);
    await app.evaluate(`[...document.querySelectorAll('.tool-group')].pop().querySelector(':scope > summary .group-thumbs img').click()`);
    await sleep(300);
    check('(e) a group thumbnail opens the lightbox without opening the group', await app.evaluate(`document.getElementById('lightbox').open && ![...document.querySelectorAll('.tool-group')].pop().open`));
    await app.evaluate(`document.getElementById('lightbox').close()`);
    await app.evaluate(`document.getElementById('messages').scrollTop = 1e9`);
    await both(app, 'e-group', await last(app, '.tool-group'), 16);

    figuresBefore = await app.evaluate(`[...document.querySelectorAll('.reply-image img')].map((i) => i.getAttribute('src'))`);
    await both(app, 'e-window');
    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
  }

  if (figuresBefore.length) {
    // A relaunch on the same profile shows the same images
    app = await launch({ mode: 'bypass', profile, project });
    try {
      // The relaunched window may open a new session: bring the earlier one back from the sidebar
      if (!(await app.count('.reply-image'))) await app.click('.session-item:not(.active)');
      await app.waitFor(`document.querySelectorAll('.reply-image img').length >= ${figuresBefore.length}`, 20_000, 'the transcript to come back');
      await imagesLoaded(app);
      const after = await app.evaluate(`[...document.querySelectorAll('.reply-image img')].map((i) => i.getAttribute('src'))`);
      check('relaunch: the same images in the same order', JSON.stringify(after) === JSON.stringify(figuresBefore), { before: figuresBefore, after });
      check('relaunch: no show_image tool rows', (await app.count('.tool[data-tool="show_image"]:not([hidden])')) === 0);
      await both(app, 'f-relaunch');
    } finally {
      await app.close();
    }
  }
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
  console.log(`screenshots: ${shots}`);
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
