// Live checks of the look tabs of Settings → Mods (Background, Chat bar, Conversation, Theme), in the real window:
// each tab's preview shows what is in use; a click on another version previews it there and leaves the window as it
// is; Use applies it to the window; Default undoes it; the first Use of a look of yours asks once (and Cancel leaves
// everything as it was); "Use the set" applies a set's parts together; New ⌄ → From a template writes a look
// that shows previewed, not applied, and Ask the agent… fills the composer; the chat card of a new look offers
// Preview (its tab, with it previewed) and Use.
// Screenshots: each look tab in light and dark (one of them with another version previewed), the Use confirmation,
// and the chat card, at scale 2.
// Run: npm run build && node test/live/look-tabs.js [shots-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.argv[2] || process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-look-tabs-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const js = (v) => JSON.stringify(v);

const PAPER = '#d97757';
const MIDNIGHT = '#2f5bcc';
const APP_ACCENT = '#1f66c4';
const TEAL = 'rgb(0, 128, 128)';

function writeMod(root, id, manifest, files) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), js({ protocol: 1, id, version: '0.1.0', ...manifest }));
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), text);
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-look-tabs-profile-'));
  const userMods = path.join(profile, 'home-config', 'mods');
  // A chat bar look of yours that asks for a permission: its first Use shows the approval
  writeMod(userMods, 'teal-bar', { name: 'Teal bar', permissions: ['session:read'], contributes: { looks: [{ id: 'main', title: 'Teal', target: 'composer', styles: ['look.css'] }] } }, { 'look.css': `#composer { border-color: ${TEAL} !important; } :scope { --teal-on: 1; }` });

  const app = await launch({ mock: true, profile, scale: 2, config: { theme: 'light' } });
  const ev = app.evaluate;
  const rpc = (m, ...a) => ev(`window.oc.rpc(${js(m)}, ...${js(a)})`);
  const layout = () => ev(`window.oc.getConfig().then((c) => c.mods.layout)`);
  const sr = (tab) => `document.querySelector('.sp-look-tab[data-subtab="${tab}"] .sp-look-pane .lp-host').shadowRoot`;
  const inPane = (tab, expr) => ev(`(() => { const r = ${sr(tab)}; return r ? (${expr}) : null; })()`);
  const st = (tab) => ev(`window.__oc_debug.looks.state(${js(tab)})`);
  const openTab = async (tab, preview) => {
    await ev(`window.__oc_debug.settings.open('mods', ${js(preview === undefined ? { tab } : { tab, preview })})`);
    await sleep(900);
  };
  const card = (tab, ref) => `.sp-look-tab[data-subtab="${tab}"] .sp-look-card[data-ref="${ref ?? ''}"]`;
  const clickCard = async (tab, ref) => {
    await app.click(card(tab, ref));
    await sleep(900);
  };
  const clickUse = async (tab) => {
    await app.click(`.sp-look-tab[data-subtab="${tab}"] .sp-look-use`);
    await sleep(900);
  };
  const headText = (tab) => app.text(`.sp-look-tab[data-subtab="${tab}"] .sp-look-current`);
  const accent = () => ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
  const paneAccent = (tab) => inPane(tab, `getComputedStyle(r.querySelector('.lp-root')).getPropertyValue('--accent').trim()`);
  const closeSettings = async () => {
    await ev(`document.querySelector('#settings').open && document.querySelector('#settings-close').click()`);
    await sleep(400);
  };
  // In the hidden window a capture right after Settings changed can come back as a stale surface tiled 2 × 2 inside the
  // clip, where the rig cannot tell it from the page: a tiny capture first makes the compositor draw a fresh frame.
  const fresh = () => app.cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
  const shotOf = async (name, selector, margin = 0) => {
    await fresh();
    return app.screenshotOf(path.join(SHOTS, `${name}.png`), selector, margin);
  };
  const shotSettings = (name) => shotOf(name, '#settings');
  const setScheme = async (scheme) => {
    await ev(`(async () => { const c = await window.oc.getConfig(); c.theme = ${js(scheme)}; await window.oc.setConfig(c); document.documentElement.dataset.theme = ${js(scheme)}; })()`);
    await sleep(900);
  };
  const TABS = ['backgrounds', 'chat-bar', 'conversation', 'themes'];
  /** The background preview's geometry: the background fills the stage, which fills the pane; the window is inset */
  const BG_GEOMETRY = `(() => {
    const pane = document.querySelector('.sp-look-tab[data-subtab="backgrounds"] .sp-look-pane');
    const st = pane && pane.querySelector('.lp-stage');
    const bd = st && st.querySelector(':scope > .lp-stage-backdrop');
    const host = st && st.querySelector(':scope > .lp-host');
    if (!pane || !st || !bd || !host) return null;
    const p = pane.getBoundingClientRect(), s = st.getBoundingClientRect(), b = bd.getBoundingClientRect(), h = host.getBoundingClientRect();
    const f = bd.querySelector('iframe');
    const fr = f && f.getBoundingClientRect();
    // Nothing of the page between the background and the eye in the band around the window
    const x = s.left + (h.left - s.left) / 2, y = s.top + (h.top - s.top) / 2;
    const top = document.elementFromPoint(x, y);
    return {
      src: f ? f.src : '',
      // the stage's box inside its hairline border
      fills: Math.abs(p.width - s.width) < 2 && Math.abs(b.width - st.clientWidth) < 1 && Math.abs(b.height - st.clientHeight) < 1,
      frameFills: !!fr && Math.abs(fr.width - st.clientWidth) < 1 && Math.abs(fr.height - st.clientHeight) < 1,
      size: [p.width, s.width, st.clientWidth, b.width, fr ? fr.width : 0].map(Math.round),
      inset: (h.left - s.left) / s.width,
      covered: !!top && top !== bd && top !== st && !bd.contains(top),
    };
  })()`;
  const BACKGROUNDS = ['backgrounds/aurora', 'backgrounds/constellation', 'backgrounds/grid', 'backgrounds/dusk', 'hyperspace/starfield'];
  /** Each bundled background previewed in the pane, the live page said hello, and a picture of the pane */
  const backgroundShots = async (scheme) => {
    await openTab('backgrounds');
    for (const ref of BACKGROUNDS) {
      await ev(`window.__oc_debug.looks.preview('backgrounds', ${js(ref)})`);
      await app.waitFor(`window.__oc_debug.mods.previews().some((p) => p.key === ${js(ref)} && p.hello && p.visible)`, 10_000, `the ${ref} preview`).catch(() => {});
      await sleep(1600);
      const g = await ev(BG_GEOMETRY);
      check(`${scheme}: ${ref} fills the preview, live`, g && g.fills && g.frameFills && !g.covered && (await ev(`window.__oc_debug.mods.previews().some((p) => p.key === ${js(ref)} && p.hello && p.visible)`)), g);
      await shotOf(`background-${ref.split('/')[1]}-${scheme}`, '.sp-look-tab[data-subtab="backgrounds"] .sp-look-pane');
    }
    await ev(`window.__oc_debug.looks.preview('backgrounds', undefined)`);
    await sleep(600);
  };

  try {
    await ev(`(() => { window.__oc_debug.user('Make the retry backoff configurable.'); window.__oc_debug.renderMarkdown('Sure. The retry loop in \`login.ts\` waits a fixed **3 seconds**; I will take the delay from the options instead.'); })()`);
    await app.waitFor(`window.oc.rpc('mods.list').then((l) => l.some((m) => m.key === 'teal-bar'))`, 15_000, 'the user look to be listed');

    // ---------- Each tab shows what is in use ----------
    await rpc('mods.use', { background: 'hyperspace/starfield', composer: 'hyperspace/cockpit', conversation: 'hyperspace/holo', theme: 'theme-paper' });
    await app.waitFor(`document.querySelector('#chatbar').dataset.look === 'hyperspace/cockpit' && !!document.querySelector('style[data-mod="theme-paper"]')`, 10_000, 'the looks in the window');
    await app.click('#settings-btn');
    await sleep(500);
    for (const tab of TABS) {
      await openTab(tab);
      const s = await st(tab);
      check(`${tab}: the preview shows what is in use, marked In use`, s && !s.previewing && s.shown === s.current && s.current !== null && /In use/.test((await headText(tab)) || '') && (await app.exists(`${card(tab, s.current)}.current.selected`)), s);
    }
    await openTab('chat-bar');
    check('Chat bar: its preview is the sample chat bar in the Cockpit look', (await inPane('chat-bar', `r.querySelector('#chatbar')?.dataset.look`)) === 'hyperspace/cockpit' && (await inPane('chat-bar', `!!r.querySelector('#input[placeholder]') && !!r.querySelector('#send-btn') && !!r.querySelector('#model-btn') && !!r.querySelector('#mode-btn') && !!r.querySelector('#context-meter .meter-ring')`)));
    await openTab('conversation');
    check('Conversation: a sample exchange (bubble, reply with code and a list, a folded tool line, tasks) in the Holo look', (await inPane('conversation', `r.querySelector('#messages')?.dataset.look`)) === 'hyperspace/holo' && (await inPane('conversation', `!!r.querySelector('.msg.user .bubble') && !!r.querySelector('.msg.assistant .md .code-block') && !!r.querySelector('.msg.assistant .md ul') && !!r.querySelector('.tool-group > summary') && r.querySelectorAll('.task-row').length === 3`)));
    await openTab('backgrounds');
    await app.waitFor(`window.__oc_debug.mods.previews().some((p) => p.key === 'hyperspace/starfield' && p.hello && p.visible)`, 10_000, 'the live preview of the Starfield').catch(() => {});
    const bgGeo = await ev(BG_GEOMETRY);
    check('Background: the live Starfield fills the whole preview, undimmed, around the miniature window', bgGeo && /hyperspace\.html/.test(bgGeo.src) && bgGeo.fills && bgGeo.frameFills && bgGeo.inset > 0.05 && !bgGeo.covered, bgGeo);
    check('… and shows through the window\'s surfaces at the chosen Dim, as in the window', (await inPane('backgrounds', `r.querySelector('.lp-root').classList.contains('mod-bg') && r.querySelector('.lp-root').style.getPropertyValue('--mod-cover') === '82%' && /\\/ 0\\.82\\)$|, 0\\.82\\)$/.test(getComputedStyle(r.querySelector('.main')).backgroundColor) && !!r.querySelector('.sidebar .session-item')`)) === true, await inPane('backgrounds', `getComputedStyle(r.querySelector('.main')).backgroundColor`));
    check('Background: the Dim slider is under it', await app.evaluate(`!!document.querySelector('.sp-look-tab[data-subtab="backgrounds"] #sp-row-background-dim input[type=range]:not(:disabled)')`));
    await ev(`(() => { const r = document.querySelector('#sp-row-background-dim input[type=range]'); r.value = '30'; r.dispatchEvent(new Event('input')); })()`);
    await sleep(300);
    const dimmed = await inPane('backgrounds', `[r.querySelector('.lp-root').style.getPropertyValue('--mod-cover'), getComputedStyle(r.querySelector('.main')).backgroundColor]`);
    check('moving Dim changes the preview at once (the window once it is let go)', dimmed[0] === '30%' && /0\.3\)$/.test(dimmed[1]) && (await layout()).backgroundDim === 0.82, dimmed);
    await shotOf('background-dim-30-light', '.sp-look-tab[data-subtab="backgrounds"] .sp-look-pane');
    await ev(`(() => { const r = document.querySelector('#sp-row-background-dim input[type=range]'); r.dispatchEvent(new Event('change')); })()`);
    await app.waitFor(`window.oc.getConfig().then((c) => c.mods.layout.backgroundDim === 0.3)`, 5000, 'Dim saved').catch(() => {});
    check('… and let go, it is the window\'s Dim', (await layout()).backgroundDim === 0.3 && (await ev(`document.documentElement.style.getPropertyValue('--mod-cover')`)) === '30%');
    await ev(`(() => { const r = document.querySelector('#sp-row-background-dim input[type=range]'); r.value = '80'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
    await sleep(500);
    const cardGeo = await ev(`(() => { const c = document.querySelector('.sp-look-tab[data-subtab="backgrounds"] .sp-look-card[data-ref="hyperspace/starfield"] .lp-stage'); const b = c && c.querySelector(':scope > .lp-stage-backdrop'); const h = c && c.querySelector(':scope > .lp-host'); if (!c || !b || !h) return null; const cr = c.getBoundingClientRect(), br = b.getBoundingClientRect(), hr = h.getBoundingClientRect(); return { frame: !!b.querySelector('iframe'), fills: Math.abs(br.width - cr.width) < 1 && Math.abs(br.height - cr.height) < 1, inset: (hr.left - cr.left) / cr.width }; })()`);
    check('a background\'s card shows the background itself, undimmed, around a small window', cardGeo && cardGeo.frame && cardGeo.fills && cardGeo.inset > 0.1, cardGeo);
    await backgroundShots('light');
    await openTab('themes');
    check('Theme: a miniature window in the Paper tokens (sidebar rows, transcript, a card, a confirming button, a switch)', (await paneAccent('themes')) === PAPER && (await inPane('themes', `!!r.querySelector('.sidebar .session-item') && !!r.querySelector('#messages .msg.user') && !!r.querySelector('.mod-offer') && !!r.querySelector('.btn.primary') && !!r.querySelector('input.switch')`)));
    check('the previews take no input and live in their own shadow roots (no #chatbar of theirs in the document)', onlyTheWindowsIds(await ev(`document.querySelectorAll('#chatbar').length + ':' + document.querySelectorAll('#messages').length`)) && (await inPane('themes', `r.querySelector('.lp-root').hasAttribute('inert')`)));
    for (const tab of TABS) {
      await openTab(tab);
      await shotSettings(`tab-${tab}-light`);
    }

    // ---------- Previewing another version: the preview changes, the window does not ----------
    await openTab('themes');
    await clickCard('themes', 'theme-midnight');
    let s = await st('themes');
    check('Theme: a click on Midnight previews it', s.previewing && s.shown === 'theme-midnight' && (await paneAccent('themes')) === MIDNIGHT && /Preview/.test((await headText('themes')) || '') && (await app.exists('.sp-look-tab[data-subtab="themes"] .sp-look-use')), s);
    check('… and the window keeps Paper', (await accent()) === PAPER && (await layout()).theme === 'theme-paper');
    await shotSettings('tab-themes-previewing-midnight-light');
    await openTab('chat-bar');
    await clickCard('chat-bar', null);
    check('Chat bar: previewing Default drops the look from the preview only', (await inPane('chat-bar', `r.querySelector('#chatbar').dataset.look ?? null`)) === null && (await ev(`document.querySelector('#chatbar').dataset.look`)) === 'hyperspace/cockpit');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-acts .btn:not(.primary)');
    await sleep(500);
    check('Back to current shows the one in use again', !(await st('chat-bar')).previewing && (await inPane('chat-bar', `r.querySelector('#chatbar').dataset.look`)) === 'hyperspace/cockpit');

    // ---------- Use applies it; Default undoes it ----------
    await openTab('themes');
    await clickUse('themes');
    await app.waitFor(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === ${js(MIDNIGHT)}`, 8000, 'Midnight in the window').catch(() => {});
    s = await st('themes');
    check('Theme: Use applies Midnight to the window, one theme at a time', (await accent()) === MIDNIGHT && (await layout()).theme === 'theme-midnight' && (await ev(`[...document.querySelectorAll('style[data-mod]')].map((x) => x.dataset.mod).join()`)) === 'theme-midnight' && !s.previewing && s.current === 'theme-midnight', s);
    check('… without asking (a built-in look)', !(await ev(`document.querySelector('#confirm-dialog').open`)));
    await clickCard('themes', null);
    check('Theme: Default previewed in the pane, the window still Midnight', (await paneAccent('themes')) === APP_ACCENT && (await accent()) === MIDNIGHT);
    await clickUse('themes');
    await app.waitFor(`!document.querySelector('style[data-mod]')`, 8000, 'the theme to go').catch(() => {});
    check('Theme: Use on Default puts the app\'s own look back', (await accent()) === APP_ACCENT && (await layout()).theme === null && (await st('themes')).current === null);

    // ---------- The first Use of a look of yours asks, once ----------
    await openTab('chat-bar');
    check('a look of yours shows in the grid, marked as asking first', (await app.exists(card('chat-bar', 'teal-bar/main'))) && (await app.exists(`${card('chat-bar', 'teal-bar/main')} .sp-look-asks`)));
    await clickCard('chat-bar', 'teal-bar/main');
    check('Teal previewed: the preview\'s chat bar is teal, the window\'s is not', (await inPane('chat-bar', `getComputedStyle(r.querySelector('#composer')).borderTopColor`)) === TEAL && (await ev(`getComputedStyle(document.querySelector('#composer')).borderTopColor`)) !== TEAL);
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-use');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 5000, 'the Use confirmation').catch(() => {});
    const confirmText = await app.text('#confirm-dialog');
    check('its first Use asks: what its pages may do and that it restyles the chat bar', /Use Teal bar\?/.test(confirmText || '') && /Read the session on screen/.test(confirmText || '') && /restyles the chat bar/.test(confirmText || ''), confirmText);
    await shotOf('use-confirmation-light', '#confirm-dialog', 16);
    await app.click('#confirm-cancel');
    await sleep(600);
    check('Cancel leaves the window and the layout as they were', (await ev(`document.querySelector('#chatbar').dataset.look`)) === 'hyperspace/cockpit' && (await layout()).looks.composer === 'hyperspace/cockpit' && (await st('chat-bar')).shown === 'teal-bar/main');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-use');
    await app.waitFor(`document.querySelector('#confirm-dialog').open`, 5000, 'the Use confirmation again').catch(() => {});
    await app.click('#confirm-ok');
    await app.waitFor(`document.querySelector('#chatbar').dataset.look === 'teal-bar/main'`, 8000, 'Teal in the window').catch(() => {});
    // The bar's border colour eases in (from the Cockpit's glow)
    await app.waitFor(`getComputedStyle(document.querySelector('#composer')).borderTopColor === ${js(TEAL)}`, 5000, 'the teal border').catch(() => {});
    const teal = { look: await ev(`document.querySelector('#chatbar').dataset.look`), border: await ev(`getComputedStyle(document.querySelector('#composer')).borderTopColor`) };
    check('confirmed: Teal is in use in the window', teal.look === 'teal-bar/main' && teal.border === TEAL, teal);
    await clickCard('chat-bar', null);
    await clickUse('chat-bar');
    check('Default: the chat bar is the app\'s own again', (await ev(`document.querySelector('#chatbar').dataset.look ?? null`)) === null && (await layout()).looks.composer === null);
    await clickCard('chat-bar', 'teal-bar/main');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-use');
    await sleep(900);
    check('a second Use of it does not ask again', !(await ev(`document.querySelector('#confirm-dialog').open`)) && (await ev(`document.querySelector('#chatbar').dataset.look`)) === 'teal-bar/main');

    // ---------- The whole set ----------
    await rpc('mods.use', { background: null, composer: null, conversation: null });
    await openTab('backgrounds');
    await clickCard('backgrounds', 'hyperspace/starfield');
    check('a set shows "Use the set" next to Use', /Use the set/.test((await headText('backgrounds')) || '') && (await app.exists('.sp-look-tab[data-subtab="backgrounds"] .sp-look-use')));
    await app.click('.sp-look-tab[data-subtab="backgrounds"] .sp-look-acts button[aria-label^="Use the set"]');
    await app.waitFor(`document.querySelector('#messages').dataset.look === 'hyperspace/holo' && document.querySelector('#chatbar').dataset.look === 'hyperspace/cockpit' && document.documentElement.classList.contains('mod-bg')`, 10_000, 'the whole set in the window').catch(() => {});
    const L1 = await layout();
    check('"Use the set" applies its background, chat bar look and conversation look together', L1.background === 'hyperspace/starfield' && L1.looks.composer === 'hyperspace/cockpit' && L1.looks.conversation === 'hyperspace/holo' && L1.theme === null, L1);
    check('… and the tab shows it in use, with no set left to use', !(await st('backgrounds')).previewing && !/Use the set/.test((await headText('backgrounds')) || ''));

    // ---------- New ⌄: from a template (previewed, not applied), Ask the agent ----------
    await openTab('chat-bar');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-new');
    await sleep(300);
    const menu = await ev(`[...document.querySelectorAll('.sp-look-tab[data-subtab="chat-bar"] .sp-menu .sp-menu-item')].map((b) => b.textContent)`);
    check('New ⌄ offers Ask the agent… and From a template…', JSON.stringify(menu) === js(['Ask the agent…', 'From a template…']), menu);
    await ev(`[...document.querySelectorAll('.sp-look-tab[data-subtab="chat-bar"] .sp-menu .sp-menu-item')].find((b) => /template/.test(b.textContent)).click()`);
    await sleep(300);
    check('From a template opens the New form in the tab, at a chat bar look', (await ev(`(() => { const f = document.querySelector('.sp-look-tab[data-subtab="chat-bar"] .sp-look-form-slot .sp-form'); return !!f && !f.hidden && /New chat bar look/.test(f.innerText) && f.querySelector('select').value === 'look:composer'; })()`)) === true);
    await app.fill('.sp-look-tab[data-subtab="chat-bar"] .sp-look-form-slot input[aria-label="Name of the new mod"]', 'Mint bar');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-form-slot .btn.primary');
    await app.waitFor(`window.__oc_debug.looks.state('chat-bar')?.shown === 'mint-bar/main'`, 10_000, 'the new look previewed').catch(() => {});
    s = await st('chat-bar');
    check('the new look shows in the grid, previewed, not applied', s.previewing && s.shown === 'mint-bar/main' && s.versions.includes('mint-bar/main') && (await layout()).looks.composer === 'hyperspace/cockpit' && (await ev(`document.querySelector('#chatbar').dataset.look`)) === 'hyperspace/cockpit', s);
    await app.waitFor(`(() => { const r = ${sr('chat-bar')}; return r && r.querySelector('#chatbar').dataset.look === 'mint-bar/main'; })()`, 5000, 'the starter in the preview').catch(() => {});
    check('… drawn with its own stylesheet in the preview', (await inPane('chat-bar', `r.querySelector('#chatbar').dataset.look`)) === 'mint-bar/main');
    await app.click('.sp-look-tab[data-subtab="chat-bar"] .sp-look-new');
    await sleep(300);
    await ev(`[...document.querySelectorAll('.sp-look-tab[data-subtab="chat-bar"] .sp-menu .sp-menu-item')].find((b) => /Ask the agent/.test(b.textContent)).click()`);
    await sleep(600);
    check('Ask the agent… closes Settings and starts the prompt in the composer', !(await ev(`document.querySelector('#settings').open`)) && (await ev(`document.querySelector('#input').value`)) === 'Make a chat bar look that ' && (await ev(`document.activeElement === document.querySelector('#input')`)));
    await app.fill('#input', '');

    // ---------- The chat card of a new look: Preview and Use ----------
    await rpc('mods.use', { background: null, composer: null, conversation: null });
    writeMod(userMods, 'dusk-chat', { name: 'Dusk chat', description: 'Warm bubbles for the conversation.', contributes: { looks: [{ id: 'main', title: 'Dusk', target: 'conversation', styles: ['look.css'] }] } }, { 'look.css': '.msg.user .bubble { background: rgb(120, 60, 40) !important; color: #fff; }' });
    await app.waitFor(`Boolean(document.querySelector('.mod-offer[data-mod="dusk-chat"] .mod-offer-preview'))`, 15_000, 'the chat card of the new look').catch(() => {});
    const cardText = await app.text('.mod-offer[data-mod="dusk-chat"]');
    check('the chat card of a new look offers Preview and Use (no Turn on)', /New look/.test(cardText || '') && (await app.exists('.mod-offer[data-mod="dusk-chat"] .mod-offer-use')) && !(await app.exists('.mod-offer[data-mod="dusk-chat"] .mod-offer-on')), cardText);
    await ev(`document.querySelector('.mod-offer[data-mod="dusk-chat"]').scrollIntoView({ block: 'center' })`);
    await ev(`document.activeElement && document.activeElement.blur()`);
    await sleep(400);
    await shotOf('chat-card-light', '.mod-offer[data-mod="dusk-chat"]', 16);
    await setScheme('dark');
    await shotOf('chat-card-dark', '.mod-offer[data-mod="dusk-chat"]', 16);
    await setScheme('light');
    await app.click('.mod-offer[data-mod="dusk-chat"] .mod-offer-preview');
    await sleep(1200);
    const now = await ev(`window.__oc_debug.settings.state()`);
    s = await st('conversation');
    check("the card's Preview opens Settings → Mods → Conversation with it previewed", now.open && now.section === 'mods' && now.tab === 'conversation' && s.previewing && s.shown === 'dusk-chat/main', { now, s });
    check('… in the preview only', (await inPane('conversation', `getComputedStyle(r.querySelector('.msg.user .bubble')).backgroundColor`)) === 'rgb(120, 60, 40)' && (await ev(`document.querySelector('#messages').dataset.look ?? null`)) === null);
    await shotSettings('tab-conversation-previewing-card-light');
    await closeSettings();
    await app.click('.mod-offer[data-mod="dusk-chat"] .mod-offer-use');
    await app.waitFor(`document.querySelector('#messages').dataset.look === 'dusk-chat/main'`, 8000, 'the card to use the look').catch(() => {});
    check("the card's Use approves and applies it (the card is the approval)", (await ev(`document.querySelector('#messages').dataset.look`)) === 'dusk-chat/main' && (await ev(`document.querySelector('.mod-offer[data-mod="dusk-chat"]').classList.contains('done')`)) && /in use/i.test((await app.text('.mod-offer[data-mod="dusk-chat"]')) || ''));

    // ---------- Dark: each tab, one with another version previewed ----------
    await rpc('mods.use', { theme: 'theme-paper', conversation: 'hyperspace/holo', composer: 'hyperspace/cockpit', background: 'hyperspace/starfield' });
    await setScheme('dark');
    await app.click('#settings-btn');
    await sleep(500);
    for (const tab of TABS) {
      await openTab(tab);
      await shotSettings(`tab-${tab}-dark`);
    }
    await backgroundShots('dark');
    await openTab('themes');
    await clickCard('themes', 'theme-glass');
    await sleep(600);
    check('dark: previewing Glass leaves the window in Paper', (await st('themes')).shown === 'theme-glass' && (await accent()) !== MIDNIGHT && !!(await ev(`document.querySelector('style[data-mod="theme-paper"]')`)));
    await shotSettings('tab-themes-previewing-glass-dark');
    await openTab('chat-bar');
    await clickCard('chat-bar', 'teal-bar/main');
    await shotSettings('tab-chat-bar-previewing-teal-dark');
    await closeSettings();
    await setScheme('light');

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 5));
    console.log(`screenshots: ${SHOTS}`);
  } catch (err) {
    check(`crashed: ${err && err.stack}`, false);
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();

/** "1:1": the window's own #chatbar and #messages, and no copy of them in the document */
function onlyTheWindowsIds(text) {
  return text === '1:1';
}
