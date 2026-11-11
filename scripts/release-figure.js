// Renders a release-notes figure (docs/releasing.md, rule 4): a few horizontal bars of one measure and one hero number,
// 1600 px wide and readable at half that. The numbers live in a JSON file beside the image, so the figure is drawn
// from what was measured and can be drawn again.
//
// Run: npx electron scripts/release-figure.js docs/releases/0.13.0/token-saving.json
// Writes docs/releases/0.13.0/token-saving.png. The JSON:
//   { "title": "…", "subtitle": "…",
//     "bars": [{ "label": "0.12.0", "value": 0.3812 }, …, { "label": "0.13.0", "value": 0.077, "now": true }],
//     "format": "$0.00",            how a bar's value is written: "$0.00", "$0.000", "0", "0K", "0%" or "0 ms"
//     "hero": { "value": "−80%", "label": "cost of a session" },
//     "source": "docs/token-bench.md" }
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const input = process.argv.slice(2).find((a) => a.endsWith('.json'));
if (!input) {
  console.error('usage: npx electron scripts/release-figure.js <figure.json>');
  process.exit(2);
}
const file = path.resolve(input);
const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = file.replace(/\.json$/, '.png');

// A data folder of its own, removed a moment after this process has gone (see social-preview.js)
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'silo-figure-'));
app.setPath('userData', userData);
app.dock?.hide();
app.on('quit', () => spawn('/bin/sh', ['-c', 'sleep 2; rm -rf "$0"', userData], { detached: true, stdio: 'ignore' }).unref());

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function write(value, format = '0') {
  if (format.startsWith('$')) return '$' + value.toFixed((format.split('.')[1] || '').length);
  if (format === '0K') return (value / 1000).toFixed(value < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
  if (format === '0%') return Math.round(value) + '%';
  if (format === '0 ms') return Math.round(value) + ' ms';
  return Math.round(value).toLocaleString('en-US');
}

const max = Math.max(...spec.bars.map((b) => b.value));
// One hue: the release's own bar in the accent, the ones before it a lighter step of the same ramp (both validated
// against this surface as an ordinal pair). Text wears the text colours, never the bar's.
const rows = spec.bars
  .map(
    (b) => `<div class="row">
  <div class="name${b.now ? ' now' : ''}">${esc(b.label)}</div>
  <div class="track"><div class="bar${b.now ? ' now' : ''}" style="width:${((b.value / max) * 100).toFixed(2)}%"></div><div class="value">${esc(write(b.value, spec.format))}</div></div>
</div>`,
  )
  .join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html { background: #fcfcfb; }
body { margin: 0; width: 800px; zoom: 2; background: #fcfcfb; color: #0b0b0b;
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif; }
.figure { padding: 36px 40px 30px; }
h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.sub { margin: 6px 0 0; font-size: 13px; color: #52514e; }
.body { display: flex; align-items: center; gap: 36px; margin-top: 30px; }
.bars { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 18px; border-left: 1px solid #e3e2dd; padding: 6px 0; }
.row { display: flex; flex-direction: column; gap: 6px; }
.name { font-size: 13px; color: #52514e; padding-left: 12px; }
.name.now { color: #0b0b0b; font-weight: 600; }
.track { display: flex; align-items: center; gap: 10px; padding-right: 64px; }
.bar { height: 22px; min-width: 3px; background: #86b6ef; border-radius: 0 4px 4px 0; }
.bar.now { background: #2a78d6; }
.value { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; margin-right: -64px; }
.hero { width: 210px; flex: none; text-align: left; }
.hero .n { font-size: 68px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
.hero .l { margin-top: 8px; font-size: 14px; color: #52514e; line-height: 1.35; }
.src { margin-top: 26px; font-size: 11.5px; color: #8a8982; }
</style></head><body><div class="figure">
<h1>${esc(spec.title)}</h1>
${spec.subtitle ? `<p class="sub">${esc(spec.subtitle)}</p>` : ''}
<div class="body">
  <div class="bars">
${rows}
  </div>
  ${spec.hero ? `<div class="hero"><div class="n">${esc(spec.hero.value)}</div><div class="l">${esc(spec.hero.label)}</div></div>` : ''}
</div>
${spec.source ? `<div class="src">Measured: ${esc(spec.source)}</div>` : ''}
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1600, height: 1200, show: false, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  // The page is laid out at 800 px and zoomed to 1600; the box it reports is already in zoomed (window) pixels
  const height = Math.ceil(await win.webContents.executeJavaScript('document.querySelector(".figure").getBoundingClientRect().height'));
  win.setContentSize(1600, height);
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1600, height });
  fs.writeFileSync(out, img.resize({ width: 1600 }).toPNG());
  console.log('wrote', path.relative(process.cwd(), out), JSON.stringify(img.getSize()));
  app.quit();
});
