// Pictures of every Settings page, for review: the built app on a throwaway profile with the mock model, the window
// 1100 px wide and the dialog let grow to the window's height, so a page is pictured whole. Each page is pictured with
// its Advanced closed and open; then dark (General, Models, Developer), Appearance over a background mod, and the
// states of Models worth seeing: a gateway with a long list of models and a key saved in the app, a provider with no
// key, the Add provider form, and a test that failed. Also writes every row's words to rows.txt, so a review can read
// them all.
//
//   npm run build && node scripts/settings-shots.js [out dir, default ./shots]
//
// Nothing here touches your own profile, settings or keys: every launch uses a temp profile and config folder, and
// the "key" pictured is made up.
const fs = require('node:fs');
const path = require('node:path');
const { launch, sleep } = require(path.join(__dirname, '..', 'test', 'live', 'rig.js'));

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'shots'));
const PAGES = ['general', 'model', 'permissions', 'appearance', 'browser', 'remote', 'mods', 'mcp', 'skills', 'history', 'developer'];
const WIDTH = 1100;
const lines = [];

/** Opens Settings (once) and lets the dialog take the window's height. */
async function openSettings(app) {
  if (!(await app.evaluate(`document.querySelector('#settings').open`))) await app.evaluate(`document.querySelector('#settings-btn').click()`);
  await app.waitFor(`document.querySelector('#settings').open`, 10_000, 'Settings');
  await app.evaluate(`(() => { if (document.querySelector('#shots-style')) return; document.head.append(Object.assign(document.createElement('style'), { id: 'shots-style', textContent: '#settings { height: calc(100vh - 24px) !important; max-height: none !important; }' })); })()`);
}

/** Brings a page on screen. */
async function page(app, id) {
  await app.evaluate(`document.querySelector('#settings-search').value = ''; document.querySelector('#settings-search').dispatchEvent(new Event('input'))`);
  await app.click(`#sp-nav-${id}`);
  await sleep(700);
}

/** Opens or closes the page's Advanced, as a click does. */
async function setAdvanced(app, id, open) {
  return app.evaluate(`(() => { const d = document.querySelector('#sp-sec-${id} .sp-page-advanced'); if (!d) return false; if (d.classList.contains('open') !== ${open}) d.querySelector('.sp-disclosure').click(); return true; })()`);
}

/** Pictures the dialog whole, sized to the page's content (at least the 800 px it has in a usual window). */
async function shoot(app, id, name) {
  await sleep(350);
  // The dialog takes the content's height, so the line under the navigation shows at its foot as it does on screen
  await app.evaluate(`(() => { const s = document.querySelector('#sp-sec-${id}'); const body = document.querySelector('#settings-body'); const h = Math.max(800, (s ? s.scrollHeight : 0) + 45 + 4 + 40 + 2); document.querySelector('#shots-style').textContent = '#settings { height: ' + h + 'px !important; max-height: none !important; }'; body.scrollTop = 0; })()`);
  await sleep(250);
  const box = await app.evaluate(`(() => { const d = document.querySelector('#settings').getBoundingClientRect(); return { x: d.x, y: d.y, width: d.width, height: d.height }; })()`);
  await app.screenshot(path.join(out, `${name}.png`), box);
  console.log(`  ${name}.png`);
}

/** Every visible row of a page, as words: title | description | controls. */
async function words(app, id, label) {
  const rows = await app.evaluate(`(() => { const s = document.querySelector('#sp-sec-${id}'); if (!s) return []; const vis = (e) => e && e.offsetParent !== null; return [...s.querySelectorAll('h3, .sp-card-title, .sp-disclosure, .sp-row, .sp-note, .sp-tabs button')].filter(vis).map((e) => { if (!e.classList.contains('sp-row')) return { head: e.innerText.trim().replace(/\\s+/g, ' ').slice(0, 160), tag: e.tagName + '.' + e.className }; const c = e.querySelector(':scope > .sp-row-control'); const kinds = c ? [...c.querySelectorAll('select, input, textarea, button')].filter(vis).map((x) => x.tagName === 'INPUT' ? 'input:' + x.type : x.tagName === 'BUTTON' ? 'button:' + (x.innerText.trim() || x.getAttribute('aria-label') || '').slice(0, 28) : x.tagName.toLowerCase()) : []; return { row: e.dataset.row, title: (e.querySelector('.sp-row-title')?.innerText || '').trim(), desc: (e.querySelector(':scope > .sp-row-text > .sp-row-desc')?.innerText || '').trim().replace(/\\s+/g, ' '), kinds }; }); })()`);
  lines.push(`\n## ${label}`);
  for (const r of rows) lines.push(r.head !== undefined ? `  [${r.tag.split(' ')[0]}] ${r.head}` : `  - ${r.title} | ${r.desc} | ${r.kinds.join(', ')}  (${r.row})`);
}

/** Every page, Advanced closed and open (Advanced is put back closed after). */
async function allPages(app, suffix, only = PAGES) {
  for (const id of only) {
    if (!(await app.exists(`#sp-nav-${id}`))) continue;
    await page(app, id);
    const has = await setAdvanced(app, id, false);
    await shoot(app, id, `${id}${suffix}`);
    if (!has) {
      await words(app, id, `${id}${suffix}`);
      continue;
    }
    await setAdvanced(app, id, true);
    await shoot(app, id, `${id}-advanced${suffix}`);
    await words(app, id, `${id}${suffix} (Advanced open)`);
    await setAdvanced(app, id, false);
  }
}

async function setTheme(app, theme) {
  await app.evaluate(`window.oc.setConfig({ theme: ${JSON.stringify(theme)} })`);
  await app.waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)} || getComputedStyle(document.documentElement).colorScheme.includes(${JSON.stringify(theme)})`, 5000).catch(() => {});
  await sleep(400);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  let failed = false;

  // 1. Every page, light; then dark for General, Models and Developer; then Appearance over a background
  {
    const app = await launch({ mock: true, mode: 'ask', size: { width: WIDTH, height: 3200 }, scale: 1, config: { theme: 'light' } });
    try {
      console.log('Every page, light');
      await openSettings(app);
      await allPages(app, '');
      console.log('Dark');
      await setTheme(app, 'dark');
      await allPages(app, '-dark', ['general', 'model', 'developer']);
      await setTheme(app, 'light');
      console.log('Appearance over a background');
      await app.evaluate(`window.oc.rpc('mods.use', { background: 'hyperspace/starfield' }, { approve: true })`);
      await sleep(1200);
      await page(app, 'appearance');
      await shoot(app, 'appearance', 'appearance-background');
    } catch (err) {
      console.log(`FAILED: ${err.stack || err.message}`);
      failed = true;
    } finally {
      await app.close();
    }
  }

  fs.writeFileSync(path.join(out, 'rows.txt'), lines.join('\n') + '\n');
  console.log(`\nPictures and rows.txt in ${out}`);
  if (failed) process.exitCode = 1;
})();
