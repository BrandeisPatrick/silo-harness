// Live checks of looks in the real window: the bundled Hyperspace set, available without a switch, used on its tabs
// of Settings → Mods (Conversation, Chat bar, and "Use the whole set" on Background); each look measured with computed styles (the conversation look changes the
// transcript and not the sidebar or the chat bar, and the other way round); a hostile look that tries to leave its
// scope; the state attributes following a run, the theme and a setting; the background hearing `pointer`; and
// Default putting everything back.
// Run: npm run build && node test/live/looks.js      Screenshots go to $SHOTS (default: a temp folder).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-looks-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const { check, done } = checker();
const js = (v) => JSON.stringify(v);

/** Computed styles of a few elements in each region, to compare before and after a look. */
const PROBE = `(() => {
  const pick = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const cs = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)])); };
  return {
    bubble: pick('.msg.user .bubble', ['border-top-color', 'box-shadow', 'background-image', 'font-size', 'line-height']),
    reply: pick('.msg.assistant .md p', ['font-size', 'line-height', 'color']),
    verb: pick('.tool-verb', ['text-transform', 'font-family', 'font-size']),
    toolLine: pick('.tool > summary', ['font-size', 'line-height', 'color', 'height']),
    status: pick('.tool-status', ['color']),
    holo: getComputedStyle(document.querySelector('#messages')).getPropertyValue('--holo').trim(),
    sidebar: pick('.sidebar', ['background-color', 'color', 'display', 'font-family']),
    sessionItem: pick('.session-item', ['background-color', 'color', 'font-size']),
    topbar: pick('.topbar', ['background-color', 'color']),
    composer: pick('#composer', ['border-top-color', 'background-image', 'box-shadow', 'border-radius']),
    send: pick('#send-btn', ['background-color', 'color']),
    foot: pick('#model-btn', ['font-family', 'color', 'font-size']),
    barBox: (() => { const r = document.querySelector('#chatbar').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    input: pick('#input', ['font-size', 'line-height', 'caret-color']),
    rootAccent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    sidebarBg100: getComputedStyle(document.querySelector('.sidebar')).getPropertyValue('--bg-100').trim(),
    // The app's own @keyframes spin, a quarter of the way through: a probe outside every region
    spin: (() => { const e = document.createElement('div'); e.style.cssText = 'position:absolute;left:-9999px;animation:spin 1s linear -0.25s infinite paused'; document.body.append(e); const t = getComputedStyle(e).transform; e.remove(); return t; })(),
    // The app's font stack as drawn: a font-face for one of its families would change the width
    fontWidth: (() => { const e = document.createElement('span'); e.style.cssText = 'position:absolute;left:-9999px;font:15px var(--font);white-space:nowrap'; e.textContent = 'Readable text, WWW iii 0123'; document.body.append(e); const w = e.getBoundingClientRect().width; e.remove(); return Math.round(w * 10) / 10; })(),
  };
})()`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const attrs = (app, sel) => app.evaluate(`Object.fromEntries([...document.querySelector(${js(sel)}).attributes].filter((a) => a.name.startsWith('data-')).map((a) => [a.name, a.value]))`);

(async () => {
  // A user mod with a look that tries everything to escape its region (turned on through the RPC, not the card).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-looks-home-'));
  const evil = path.join(home, 'mods', 'escape-look');
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'mod.json'), js({ protocol: 1, id: 'escape-look', name: 'Escape look', version: '0.1.0', contributes: { looks: [{ id: 'x', title: 'Escape', target: 'conversation', styles: ['x.css'] }] } }));
  fs.writeFileSync(path.join(evil, 'x.css'), '} } :root { --accent: rgb(255, 0, 0); } .sidebar { background: rgb(255, 0, 0) !important; display: none !important; } @import url(nope.css); a { b: "}" } } } #composer { border-color: rgb(255, 0, 0) !important; } :scope ~ * { color: rgb(255, 0, 0) !important; } body .topbar { color: rgb(255, 0, 0) !important } @scope (body) { .sidebar { display: none !important } } .msg.user .bubble { outline: 3px solid rgb(255, 0, 0); }' +
    // Global names: the app's own keyframes, a family of the app's font stack, a custom property the app's colours inherit
    ' @keyframes spin { to { transform: translateX(300px); } } @keyframes fade-in { to { opacity: 0; } }' +
    ' @font-face { font-family: "-apple-system"; src: local("Courier"); } @font-face { font-family: BlinkMacSystemFont; src: local("Courier"); } @font-face { font-family: "SF Pro Text"; src: local("Courier"); }' +
    " @property --bg-100 { syntax: '<color>'; inherits: false; initial-value: red; }" +
    // …and a name of its own, which must still work
    ' @keyframes escape-look-own { from { opacity: 0.25; } to { opacity: 0.75; } } .msg.user .bubble { animation: escape-look-own 1s linear -0.5s infinite paused; }');

  const app = await launch({ mode: 'bypass', config: { theme: 'dark' }, env: { SILO_HARNESS_CONFIG_DIR: home } });
  const ev = app.evaluate;
  const rpc = (m, ...a) => ev(`window.oc.rpc(${js(m)}, ...${js(a)})`);
  // Measured without focus, once the composer's transitions are over, so its focus ring does not count as a change
  const probe = async () => {
    await ev(`document.activeElement && document.activeElement !== document.body && document.activeElement.blur()`);
    await sleep(350);
    return ev(PROBE);
  };
  const shot = (name) => app.screenshot(path.join(SHOTS, `${name}.png`));
  const openSettings = async (section) => {
    await ev(`(() => { if (!document.querySelector('#settings').open) document.querySelector('#settings-btn').click(); document.querySelector('#sp-nav-${section}')?.click(); })()`);
    await sleep(400);
  };
  const closeSettings = async () => {
    await ev(`document.querySelector('#settings').open && document.querySelector('#settings-close').click()`);
    await sleep(300);
  };
  /** Uses a version on its look tab, as a person does: its card (it shows in the preview), then Use; '' is Default */
  const use = async (tab, ref) => {
    await ev(`window.__oc_debug.settings.open('mods', { tab: ${js(tab)} })`);
    await sleep(300);
    await app.click(`.sp-look-tab[data-subtab="${tab}"] .sp-look-card[data-ref="${ref}"]`);
    await sleep(500);
    if (await app.exists(`.sp-look-tab[data-subtab="${tab}"] .sp-look-use`)) await app.click(`.sp-look-tab[data-subtab="${tab}"] .sp-look-use`);
    await sleep(900);
  };
  /** "Use the whole set": Hyperspace's Starfield previewed on the Background tab, then the button beside Use */
  const useSet = async () => {
    await ev(`window.__oc_debug.settings.open('mods', { tab: 'backgrounds', preview: 'hyperspace/starfield' })`);
    await sleep(500);
    await app.click('.sp-look-tab[data-subtab="backgrounds"] .sp-look-acts button[aria-label^="Use the whole set"]');
    await sleep(900);
  };
  const setOffered = () => app.exists('.sp-look-tab[data-subtab="backgrounds"] .sp-look-acts button[aria-label^="Use the whole set"]');
  const lookStyles = () => ev(`[...document.querySelectorAll('style[data-look]')].map((s) => s.dataset.look + '=' + s.dataset.ref)`);

  try {
    // A conversation to look at: a tool row, a heading, a code block, a list.
    if (app.mock) {
      const call = (name, args) => ({ id: 'c' + Math.random().toString(36).slice(2, 8), name, args });
      app.mock.state.replies.push({ toolCalls: [call('bash', { command: 'echo hello' })] });
      app.mock.state.replies.push({ content: '## Done\n\nIt says hello.\n\n```js\nconsole.log("hello");\n```\n\n- one\n- two' });
      await app.send('Run `echo hello` with the bash tool, then reply with a heading "Done", one sentence, a short js code block and a two-item list.');
    } else {
      await app.send('Run `echo hello` with the bash tool, then reply with a heading "Done", one sentence, a short js code block and a two-item list.');
    }
    await app.waitIdle();
    await app.waitFor(`Boolean(document.querySelector('.msg.assistant .md p') && document.querySelector('.tool-verb'))`, 30_000, 'the reply and the tool row');
    const before = await probe();
    check('no look at start: no look stylesheets, no state attributes', (await lookStyles()).length === 0 && !('data-look' in (await attrs(app, '#messages'))) && !('data-look' in (await attrs(app, '#chatbar'))));

    // ---------- Hyperspace is available without a switch: its looks are on their tabs ----------
    await openSettings('mods');
    const hyper = (await rpc('mods.list')).find((m) => m.key === 'hyperspace');
    check('Hyperspace is available with no switch and off (nothing of it in use)', hyper.state === 'off' && hyper.approved === true && !(await app.exists('#sp-row-mod-hyperspace')));
    const onNow = await probe();
    check('being available changes nothing until a look is used', (await lookStyles()).length === 0 && same(onNow, before), Object.keys(before).filter((k) => !same(before[k], onNow[k])).map((k) => [k, before[k], onNow[k]]));

    // ---------- Settings → Mods: the Conversation, Chat bar and Background tabs ----------
    const versions = (tab) => ev(`window.__oc_debug.looks.state(${js(tab)}).versions`);
    const convVersions = await versions('conversation');
    check('Conversation offers Holo terminal (and the escape look of yours), Chat bar Cockpit, Background Starfield, each after Default', convVersions[0] === null && convVersions[1] === 'hyperspace/holo' && convVersions.includes('escape-look/x') && (await versions('chat-bar')).join() === ',hyperspace/cockpit' && (await versions('backgrounds')).includes('hyperspace/starfield'), convVersions);
    await ev(`window.__oc_debug.settings.open('mods', { tab: 'backgrounds', preview: 'hyperspace/starfield' })`);
    await sleep(500);
    check("Hyperspace's Starfield previewed offers the whole set", await setOffered());
    await ev(`window.__oc_debug.settings.open('mods', { tab: 'conversation', preview: 'hyperspace/holo' })`);
    await sleep(600);
    await app.screenshotOf(path.join(SHOTS, 'settings-looks.png'), '.sp-look-tab[data-subtab="conversation"]', 0).catch(() => {});

    // The conversation look alone
    await use('conversation', 'hyperspace/holo');
    await app.waitFor(`document.querySelector('#messages').dataset.look === 'hyperspace/holo'`, 10_000, 'the conversation look');
    const conv = await probe();
    check('the conversation look changes the transcript', conv.holo && !same(conv.bubble, before.bubble) && !same(conv.status, before.status), { holo: conv.holo, bubble: conv.bubble });
    check('… keeps the quiet tool lines as they are (size, line height, colour, height)', same(conv.toolLine, before.toolLine) && same(conv.verb, before.verb), { before: before.toolLine, now: conv.toolLine });
    check('… keeps the reading size and line height', same(conv.reply['font-size'], before.reply['font-size']) && same(conv.reply['line-height'], before.reply['line-height']) && same(conv.bubble['font-size'], before.bubble['font-size']));
    check('… and does not touch the sidebar, the top bar, the chat bar or the page tokens', same(conv.sidebar, before.sidebar) && same(conv.sessionItem, before.sessionItem) && same(conv.topbar, before.topbar) && same(conv.composer, before.composer) && same(conv.send, before.send) && conv.rootAccent === before.rootAccent, { s: conv.sidebar, c: conv.composer });
    await ev(`window.__oc_debug.settings.open('mods', { tab: 'backgrounds', preview: 'hyperspace/starfield' })`);
    await sleep(500);
    check('with only the conversation look the whole set is still offered', await setOffered());

    // The chat bar look alone
    await use('conversation', '');
    await use('chat-bar', 'hyperspace/cockpit');
    await app.waitFor(`document.querySelector('#chatbar').dataset.look === 'hyperspace/cockpit'`, 10_000, 'the chat bar look');
    const bar = await probe();
    check('the chat bar look changes the chat bar and the row under it', !same(bar.composer, before.composer) && !same(bar.foot, before.foot), { composer: bar.composer, foot: bar.foot });
    check('… and keeps it exactly as compact (same size, same text size underneath)', same(bar.barBox, before.barBox) && bar.foot['font-size'] === before.foot['font-size'], { before: before.barBox, now: bar.barBox });
    check('… keeps the field\'s type', same(bar.input['font-size'], before.input['font-size']) && same(bar.input['line-height'], before.input['line-height']));
    check('… and does not touch the transcript or the sidebar', same(bar.bubble, before.bubble) && same(bar.reply, before.reply) && same(bar.sidebar, before.sidebar) && !bar.holo && !('data-look' in (await attrs(app, '#messages'))));

    // The whole set in one choice
    await useSet();
    await app.waitFor(`window.__oc_debug.mods.views().some((v) => v.key === 'hyperspace/starfield' && v.hello)`, 15_000, 'the Hyperspace background');
    const cfg = await ev('window.oc.getConfig()');
    check('"Use the whole set" applies the conversation look, the chat bar look and the background', cfg.mods.layout.looks.conversation === 'hyperspace/holo' && cfg.mods.layout.looks.composer === 'hyperspace/cockpit' && cfg.mods.layout.background === 'hyperspace/starfield', cfg.mods.layout);
    check('… and the tabs show them in use, with the set no longer offered', (await ev(`['conversation', 'chat-bar', 'backgrounds'].map((t) => window.__oc_debug.looks.state(t).current).join()`)) === 'hyperspace/holo,hyperspace/cockpit,hyperspace/starfield' && !(await setOffered()));
    await closeSettings();
    const set = await probe();
    check('with the set: the sidebar keeps its own style (only its translucency over the background changes)', same({ ...set.sidebar, 'background-color': '' }, { ...before.sidebar, 'background-color': '' }) && same(set.sessionItem, before.sessionItem));

    // ---------- State attributes ----------
    let a = await attrs(app, '#messages');
    check('attributes on #messages: look, running, scheme, mode, settings', a['data-look'] === 'hyperspace/holo' && a['data-running'] === 'false' && a['data-scheme'] === 'dark' && a['data-mode'] === 'bypass' && a['data-set-glow'] === 'blue' && a['data-set-motion'] === 'full', a);
    const b = await attrs(app, '#chatbar');
    check('… and the same on #chatbar', b['data-look'] === 'hyperspace/cockpit' && b['data-running'] === 'false' && b['data-set-glow'] === 'blue', b);
    const blue = set.holo;
    await rpc('mods.setSetting', 'hyperspace', 'glow', 'green');
    await app.waitFor(`document.querySelector('#messages').dataset.setGlow === 'green' && document.querySelector('#chatbar').dataset.setGlow === 'green'`, 10_000, 'data-set-glow to follow the setting');
    const green = (await probe()).holo;
    check('a setting change reaches the attribute and the look follows it', green && green !== blue, { blue, green });
    await ev(`(async () => { const c = await window.oc.getConfig(); c.theme = 'light'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'light'; })()`);
    await app.waitFor(`document.querySelector('#messages').dataset.scheme === 'light'`, 10_000, 'data-scheme to follow the theme');
    check('data-scheme follows the theme, and the glow gets its light variant', (await probe()).holo !== green);
    await ev(`(async () => { const c = await window.oc.getConfig(); c.theme = 'dark'; await window.oc.setConfig(c); document.documentElement.dataset.theme = 'dark'; })()`);
    await rpc('mods.setSetting', 'hyperspace', 'glow', 'blue');

    // A run: data-running goes true while it lasts, then back to false
    if (app.mock) app.mock.state.replies.push({ delayMs: 4000, content: 'Waited.' });
    await app.send(app.mock ? 'Wait a moment.' : 'Run `sleep 4` with the bash tool, then reply with the single word Waited.');
    await app.waitFor(`document.querySelector('#messages').dataset.running === 'true' && document.querySelector('#chatbar').dataset.running === 'true'`, 20_000, 'data-running="true" during the run');
    check('data-running is "true" on both roots while a run is in progress', true);
    await sleep(1500);
    await shot('running-dark');
    await app.waitIdle(120_000, false);
    await app.waitFor(`document.querySelector('#messages').dataset.running === 'false'`, 10_000, 'data-running="false" after the run');
    check('… and "false" once it ended', (await attrs(app, '#chatbar'))['data-running'] === 'false');

    // ---------- pointer ----------
    await ev(`window.__oc_debug.mods.clearLog()`);
    const t0 = Date.now();
    for (let i = 0; i < 40; i++) {
      await app.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400 + i * 10, y: 300 + i * 5 });
      await sleep(10);
    }
    const elapsed = (Date.now() - t0) / 1000;
    await sleep(200);
    const ptr = await ev(`window.__oc_debug.mods.log().filter((e) => e.kind === 'event' && e.method === 'pointer')`);
    check('the background hears pointer while the pointer moves', ptr.length > 0 && ptr.every((e) => e.view === 'hyperspace/starfield'), ptr.length);
    check('… at most 30 times a second', ptr.length <= Math.ceil(elapsed * 30) + 2, { events: ptr.length, seconds: elapsed });
    check('no other view hears it', !(await ev(`window.__oc_debug.mods.log().some((e) => e.method === 'pointer' && e.view !== 'hyperspace/starfield')`)));

    // ---------- A look that tries to leave its scope ----------
    await rpc('mods.reload');
    await rpc('mods.setEnabled', 'escape-look', true);
    await rpc('mods.setLayout', { looks: { conversation: 'escape-look/x' } });
    await app.waitFor(`document.querySelector('#messages').dataset.look === 'escape-look/x'`, 10_000, 'the escape look');
    const esc = await probe();
    const sidebarShown = await ev(`getComputedStyle(document.querySelector('.sidebar')).display !== 'none'`);
    check('a hostile look cannot reach the sidebar, the top bar, the chat bar or :root', sidebarShown && same({ ...esc.sidebar, 'background-color': '' }, { ...set.sidebar, 'background-color': '' }) && !/255, 0, 0/.test(esc.sidebar['background-color']) && !/255, 0, 0/.test(esc.topbar.color) && !/255, 0, 0/.test(esc.composer['border-top-color']) && esc.rootAccent === before.rootAccent, esc);
    check('… but does apply inside its region', /255, 0, 0/.test(await ev(`getComputedStyle(document.querySelector('.msg.user .bubble')).outlineColor`)));
    check("a look's @keyframes spin does not replace the app's spin", esc.spin === before.spin && /matrix/.test(before.spin), { before: before.spin, now: esc.spin });
    check("a look's @font-face for the app's families does not change the app's font", esc.fontWidth === before.fontWidth, { before: before.fontWidth, now: esc.fontWidth });
    check("a look's @property for --bg-100 does not reach the app's colours", esc.sidebarBg100 === before.sidebarBg100 && !/255, 0, 0|red/.test(esc.sidebarBg100), { before: before.sidebarBg100, now: esc.sidebarBg100 });
    check('#messages contains paint while a conversation look is on (a fixed-position layer stays in the transcript)', (await ev(`getComputedStyle(document.querySelector('#messages')).contain`)) === 'paint' && (await ev(`getComputedStyle(document.querySelector('#chatbar')).contain`)) === 'none');
    check("the look's own @keyframes still works (layered, no clash)", Math.abs(Number(await ev(`getComputedStyle(document.querySelector('.msg.user .bubble')).opacity`)) - 0.5) < 0.05);
    check('… and its @import is gone', !/@import/.test(await ev(`window.__oc_debug.mods.lookCss('conversation')`)));
    await rpc('mods.setEnabled', 'escape-look', false);
    await app.waitFor(`document.querySelector('#messages').dataset.look === undefined`, 10_000, 'the look to go with its mod');
    check('turning its mod off removes the look and the attributes', !(await lookStyles()).some((s) => s.startsWith('conversation')) && !('data-running' in (await attrs(app, '#messages'))));

    // ---------- Default restores everything ----------
    await useSet();
    await use('conversation', '');
    await use('chat-bar', '');
    await use('backgrounds', '');
    await closeSettings();
    await sleep(500);
    const after = await probe();
    check('… and the containment goes with the look', (await ev(`getComputedStyle(document.querySelector('#messages')).contain`)) === 'none');
    check('Default: no look stylesheets, no attributes, no background', (await lookStyles()).length === 0 && Object.keys(await attrs(app, '#messages')).length === 0 && Object.keys(await attrs(app, '#chatbar')).length === 0 && !(await ev(`document.documentElement.classList.contains('mod-bg')`)));
    check('… and every probed style is as it was', same(after, before), { before, after });
    const errors = app.console.filter((l) => /\[(error|exception)\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND/.test(l));
    check('no errors in the window', errors.length === 0, errors.slice(0, 5));
  } catch (err) {
    check(`crashed: ${err && err.message}`, false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})();
