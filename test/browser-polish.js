// The Browser pane's polish, headless: find in page (the step a keystroke or Enter asks for, the results Chromium sends
// folded into "3 of 12"), zoom per site (Chrome's steps, the site a level is kept under, the store's file), the context
// menu built from a right click's params, the shortcuts a key pressed inside a page stands for, where a link clicked in
// the chat goes, and browser_type refusing when its own click moved the focus into a password field. The real thing:
// test/live/browser-polish.js.
// Run: npm run build && node test/browser-polish.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (f) => require(path.join(projectDir, 'dist/main', f));
const { findStep, foldFound, findLabel } = dist('browser/find.js');
const { ZOOM_STEPS, levelOf, percentOf, nextZoom, zoomKey, cleanZoomFile, zoomFile, ZoomStore, zoomMenuItems } = dist('browser/zoom.js');
const { contextMenuTemplate, menuLabels, clipSelection, searchUrl } = dist('browser/context-menu.js');
const { shortcutOf } = dist('browser/tab.js');
const { chatLinkTarget } = dist('browser/feature.js');
const { CREDENTIAL_REFUSAL } = dist('browser/policy.js');
const { browserTools } = dist('tools/browser.js');
const { check, done } = require('./support/check.js');

(async () => {
  // ---------- 1. Find in page ----------
  check('1: an empty field stops the search', findStep('', '').kind === 'stop' && findStep('kumquat', '').kind === 'stop');
  let s = findStep('', 'kumquat');
  check('1: a new text starts a new search, forwards, case ignored', s.kind === 'find' && s.text === 'kumquat' && s.options.findNext === true && s.options.forward === true && s.options.matchCase === false, s);
  s = findStep('kumquat', 'kumquat', true);
  check('1: Enter on the same text moves to the next match (no new search)', s.kind === 'find' && s.options.findNext === false && s.options.forward === true, s);
  s = findStep('kumquat', 'kumquat', false);
  check('1: ⇧Enter moves to the one before', s.kind === 'find' && s.options.findNext === false && s.options.forward === false, s);
  s = findStep('kumqua', 'kumquat', false);
  check('1: a changed text is a new search even with ⇧Enter, from the top', s.kind === 'find' && s.options.findNext === true && s.options.forward === true, s);
  const none = { matches: 0, active: 0 };
  check('1: a result of an older request is ignored', foldFound(none, { requestId: 1, activeMatchOrdinal: 1, matches: 3, finalUpdate: true }, 2) === null);
  let f = foldFound(none, { requestId: 2, activeMatchOrdinal: 1, matches: 0, finalUpdate: false }, 2);
  check('1: an early update keeps what it does not carry yet', f && f.active === 1 && f.matches === 0 && f.final === false, f);
  f = foldFound({ matches: 0, active: 1 }, { requestId: 2, activeMatchOrdinal: 0, matches: 3, finalUpdate: true }, 2);
  check('1: the final update gives the count; the active match is at least 1 when there are matches', f && f.matches === 3 && f.active === 1 && f.final, f);
  f = foldFound({ matches: 3, active: 1 }, { requestId: 2, activeMatchOrdinal: 0, matches: 0, finalUpdate: true }, 2);
  check('1: a final update with none is none', f && f.matches === 0 && f.active === 0 && f.final, f);
  check('1: the label reads "2 of 3", "No results" when over, nothing while unknown', findLabel({ matches: 3, active: 2, final: true }) === '2 of 3' && findLabel({ matches: 0, active: 0, final: true }) === 'No results' && findLabel({ matches: 0, active: 0, final: false }) === '' && findLabel({ matches: 4, active: 0, final: false }) === '1 of 4');

  // ---------- 2. Zoom ----------
  check("2: Chrome's steps, 25 % to 500 %, 100 among them", ZOOM_STEPS[0] === 25 && ZOOM_STEPS[ZOOM_STEPS.length - 1] === 500 && ZOOM_STEPS.includes(100) && ZOOM_STEPS.every((v, i) => i === 0 || v > ZOOM_STEPS[i - 1]));
  check('2: ⌘+ twice from 100 is 125; ⌘− from 100 is 90; ⌘0 is 100', nextZoom(nextZoom(100, 'in'), 'in') === 125 && nextZoom(100, 'out') === 90 && nextZoom(250, 'reset') === 100);
  check('2: the ends stay put', nextZoom(500, 'in') === 500 && nextZoom(25, 'out') === 25);
  check('2: a level between two steps moves to the next step that way', nextZoom(115, 'in') === 125 && nextZoom(115, 'out') === 110 && nextZoom(109.5, 'in') === 125 && nextZoom(110, 'in') === 125);
  check('2: nonsense counts as 100', nextZoom(NaN, 'in') === 110 && nextZoom(0, 'out') === 90);
  check("2: Chromium's level: 120 % is level 1, 100 % level 0", Math.abs(levelOf(120) - 1) < 1e-9 && levelOf(100) === 0 && Math.abs(levelOf(144) - 2) < 1e-9);
  check('2: a level and back is the same step', ZOOM_STEPS.every((p) => percentOf(Math.pow(1.2, levelOf(p))) === p));
  check('2: the chip reads the factor in percent', percentOf(1.25) === 125 && percentOf(1) === 100 && percentOf(0) === 100 && percentOf(NaN) === 100);
  check('2: a site is the host of a web page, lower case, any port and scheme', zoomKey('https://Docs.Example.com:8443/a?b') === 'docs.example.com' && zoomKey('http://127.0.0.1:5173/') === '127.0.0.1' && zoomKey('http://[::1]:3000/') === '[::1]');
  check('2: other pages are not saved', zoomKey('file:///Users/me/a.html') === null && zoomKey('about:blank') === null && zoomKey('artifact://x/y') === null && zoomKey('nonsense') === null && zoomKey('') === null);
  const cleaned = cleanZoomFile({ 'Example.com': 125, 'a.test': 100, 'b.test': 123, 'c.test': '150', '': 110, d: 'x' });
  check('2: the file is cleaned: steps only, never 100, keys lower case', JSON.stringify(cleaned) === JSON.stringify({ 'example.com': 125, 'c.test': 150 }), cleaned);
  check('2: anything that is not an object is no levels', JSON.stringify(cleanZoomFile(null)) === '{}' && JSON.stringify(cleanZoomFile([1, 2])) === '{}' && JSON.stringify(cleanZoomFile('x')) === '{}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-zoom-'));
  const file = zoomFile(dir);
  check('2: the store is userData/browser/zoom.json', file === path.join(dir, 'browser', 'zoom.json'));
  const store = new ZoomStore(file);
  check('2: a fresh store has nothing', store.get('example.com') === undefined && JSON.stringify(store.all()) === '{}');
  store.set('example.com', 125);
  store.set('other.test', 67);
  check('2: a level is saved at once (a crash keeps it)', JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === JSON.stringify({ 'example.com': 125, 'other.test': 67 }));
  check('2: … and read back by a new store (a relaunch)', new ZoomStore(file).get('example.com') === 125 && new ZoomStore(file).get('other.test') === 67);
  store.set('example.com', 100);
  check('2: 100 forgets the site', store.get('example.com') === undefined && !('example.com' in JSON.parse(fs.readFileSync(file, 'utf8'))));
  store.set(null, 150);
  store.set('x.test', 123);
  check('2: no site, or a level that is not a step, saves nothing', JSON.stringify(store.all()) === JSON.stringify({ 'other.test': 67 }));
  fs.writeFileSync(file, '{ not json');
  check('2: a broken file is no levels, not a crash', JSON.stringify(new ZoomStore(file).all()) === '{}');
  fs.rmSync(dir, { recursive: true, force: true });
  // The View menu's items: a page of the browser goes to the browser, the app's own window zooms as the roles did
  const fakeWc = (level = 0) => ({ level, isDestroyed: () => false, getZoomLevel() { return this.level; }, setZoomLevel(l) { this.level = l; } });
  const sent = [];
  const page = fakeWc();
  const own = fakeWc();
  let focused = page;
  const items = zoomMenuItems((wc, change) => (wc === page ? (sent.push(change), true) : false), () => focused);
  const byLabel = (label, visible = true) => items.find((i) => i.label === label && (i.visible !== false) === visible);
  check('2: the View menu has Actual Size, Zoom In (⌘+ and a hidden ⌘=) and Zoom Out', JSON.stringify(items.map((i) => [i.label, i.accelerator])) === JSON.stringify([['Actual Size', 'CommandOrControl+0'], ['Zoom In', 'CommandOrControl+Plus'], ['Zoom In', 'CommandOrControl+='], ['Zoom Out', 'CommandOrControl+-']]));
  byLabel('Zoom In').click();
  byLabel('Zoom In', false).click();
  byLabel('Actual Size').click();
  check('2: with a page of the browser focused, the menu zooms the page only (one step each, through the browser)', JSON.stringify(sent) === '["in","in","reset"]' && page.level === 0 && own.level === 0, sent);
  focused = own;
  byLabel('Zoom In').click();
  byLabel('Zoom Out').click();
  byLabel('Zoom Out').click();
  check("2: with the app's window focused, the menu zooms the window by half a level, as the roles did", own.level === -0.5 && sent.length === 3, own.level);
  byLabel('Actual Size').click();
  check('2: … and Actual Size puts it back', own.level === 0);

  // ---------- 3. The context menu ----------
  const params = (o = {}) => ({ x: 10, y: 20, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }, ...o });
  const state = { canGoBack: true, canGoForward: false };
  const labels = (p, st = state) => menuLabels(contextMenuTemplate(p, st));
  const item = (p, label, st = state) => contextMenuTemplate(p, st).find((i) => i.label === label);
  check('3: on the page: Back, Forward, Reload, then Print… and Save as PDF…, then Inspect Element', JSON.stringify(labels(params())) === JSON.stringify(['Back', 'Forward', 'Reload', '-', 'Print…', 'Save as PDF…', '-', 'Inspect Element']), labels(params()));
  check('3: … Forward is disabled with no history that way, Back is not', item(params(), 'Back').enabled && !item(params(), 'Forward').enabled);
  const onLink = params({ linkURL: 'https://example.com/next', x: 5, y: 6 });
  check('3: on a link: Open Link in New Tab and Copy Link Address, no Back/Forward/Reload', JSON.stringify(labels(onLink)) === JSON.stringify(['Open Link in New Tab', 'Copy Link Address', '-', 'Print…', 'Save as PDF…', '-', 'Inspect Element']), labels(onLink));
  check('3: … which open that address in a tab and copy it', JSON.stringify(item(onLink, 'Open Link in New Tab').action) === JSON.stringify({ do: 'openTab', url: 'https://example.com/next' }) && JSON.stringify(item(onLink, 'Copy Link Address').action) === JSON.stringify({ do: 'copyText', text: 'https://example.com/next' }));
  check('3: a javascript: link can be copied, not opened', JSON.stringify(labels(params({ linkURL: 'javascript:void(0)' })).slice(0, 2)) === JSON.stringify(['Copy Link Address', '-']));
  const onImage = params({ mediaType: 'image', srcURL: 'https://example.com/cat.png' });
  check('3: on an image: Open Image in New Tab, Copy Image, Save Image As…', JSON.stringify(labels(onImage).slice(0, 3)) === JSON.stringify(['Open Image in New Tab', 'Copy Image', 'Save Image As…']) && JSON.stringify(item(onImage, 'Save Image As…').action) === JSON.stringify({ do: 'saveImage', url: 'https://example.com/cat.png' }));
  const linkedImage = params({ mediaType: 'image', srcURL: 'https://example.com/cat.png', linkURL: 'https://example.com/' });
  check('3: an image inside a link has both groups, link first', JSON.stringify(labels(linkedImage).slice(0, 6)) === JSON.stringify(['Open Link in New Tab', 'Copy Link Address', '-', 'Open Image in New Tab', 'Copy Image', 'Save Image As…']));
  const long = 'The quick brown fox jumps over the lazy dog, twice over';
  const onSel = params({ selectionText: `  ${long}\n` });
  check('3: on a selection: Copy and Search DuckDuckGo for the text, clipped', JSON.stringify(labels(onSel).slice(0, 2)) === JSON.stringify(['Copy', `Search DuckDuckGo for “${clipSelection(long)}”`]) && clipSelection(long).length <= 32 && clipSelection(long).endsWith('…'), labels(onSel));
  check('3: … the search is for the whole selection', JSON.stringify(item(onSel, `Search DuckDuckGo for “${clipSelection(long)}”`).action) === JSON.stringify({ do: 'search', query: long }) && searchUrl(long) === `https://duckduckgo.com/?q=${encodeURIComponent(long)}`);
  check('3: a short selection is not clipped', clipSelection('kumquat') === 'kumquat' && clipSelection('a\n\tb') === 'a b');
  const field = params({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
  check('3: in a field: Cut, Copy, Paste, Paste and Match Style, Select All', JSON.stringify(labels(field).slice(0, 5)) === JSON.stringify(['Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Select All']), labels(field));
  check('3: … as its edit flags allow (nothing selected: no Cut or Copy)', !item(field, 'Cut').enabled && !item(field, 'Copy').enabled && item(field, 'Paste').enabled && item(field, 'Paste and Match Style').enabled && item(field, 'Select All').enabled);
  check('3: … and no Back/Forward/Reload in a field', !labels(field).includes('Back') && !labels(field).includes('Reload'));
  const fieldSel = params({ isEditable: true, selectionText: 'kumquat', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  check('3: a selection in a field: one Copy (the field\'s), then the search', labels(fieldSel).filter((l) => l === 'Copy').length === 1 && labels(fieldSel).includes('Search DuckDuckGo for “kumquat”') && item(fieldSel, 'Cut').enabled);
  const misspelled = params({ isEditable: true, misspelledWord: 'kumqaut', dictionarySuggestions: ['kumquat', 'kumquats'] });
  check('3: a misspelled word: the suggestions, then Add to Dictionary, first', JSON.stringify(labels(misspelled).slice(0, 4)) === JSON.stringify(['kumquat', 'kumquats', 'Add to Dictionary', '-']) && JSON.stringify(item(misspelled, 'kumquat').action) === JSON.stringify({ do: 'replace', word: 'kumquat' }) && JSON.stringify(item(misspelled, 'Add to Dictionary').action) === JSON.stringify({ do: 'learn', word: 'kumqaut' }));
  check('3: … with no suggestions, No Guesses Found (disabled)', JSON.stringify(labels(params({ isEditable: true, misspelledWord: 'zzxq' })).slice(0, 2)) === JSON.stringify(['No Guesses Found', 'Add to Dictionary']) && !item(params({ isEditable: true, misspelledWord: 'zzxq' }), 'No Guesses Found').enabled);
  check('3: at most five suggestions', labels(params({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).indexOf('Add to Dictionary') === 5);
  check('3: no separator at either end, never two in a row', [params(), onLink, onImage, linkedImage, onSel, field, fieldSel, misspelled].every((p) => { const l = labels(p); return l[0] !== '-' && l[l.length - 1] !== '-' && !l.some((x, i) => x === '-' && l[i + 1] === '-'); }));
  check('3: Inspect Element is always the last item', [params(), onLink, onImage, onSel, field].every((p) => labels(p).at(-1) === 'Inspect Element'));

  // ---------- 4. The shortcuts inside a page ----------
  const key = (k, o = {}) => ({ type: 'keyDown', key: k, code: o.code ?? '', meta: o.meta ?? true, control: o.control ?? false, shift: o.shift ?? false, alt: o.alt ?? false, isAutoRepeat: o.repeat ?? false });
  check('4: ⌘F finds, ⌘L the URL bar, ⌘W closes, ⌘⇧N opens a tab', shortcutOf(key('f'), 'darwin') === 'find' && shortcutOf(key('l'), 'darwin') === 'focus-url' && shortcutOf(key('w'), 'darwin') === 'close-tab' && shortcutOf(key('N', { shift: true }), 'darwin') === 'new-tab');
  check('4: ⌘= and ⌘+ zoom in, ⌘- (and ⌘_) out, ⌘0 resets', shortcutOf(key('='), 'darwin') === 'zoom-in' && shortcutOf(key('+', { shift: true }), 'darwin') === 'zoom-in' && shortcutOf(key('-'), 'darwin') === 'zoom-out' && shortcutOf(key('_', { shift: true }), 'darwin') === 'zoom-out' && shortcutOf(key('0'), 'darwin') === 'zoom-reset');
  check('4: ⌥⌘I opens DevTools (the key reads ˆ with Option held: the code decides)', shortcutOf(key('ˆ', { alt: true, code: 'KeyI' }), 'darwin') === 'devtools' && shortcutOf(key('i', { alt: true, code: 'KeyI' }), 'darwin') === 'devtools');
  check('4: other Option combinations, ⌘⇧F, ⌘⇧W and plain keys are the page\'s', shortcutOf(key('f', { alt: true, code: 'KeyF' }), 'darwin') === null && shortcutOf(key('F', { shift: true }), 'darwin') === null && shortcutOf(key('W', { shift: true }), 'darwin') === null && shortcutOf(key('f', { meta: false }), 'darwin') === null && shortcutOf(key('a'), 'darwin') === null);
  check('4: on the Mac, Control+F, Control+N stay the text field\'s', shortcutOf(key('f', { meta: false, control: true }), 'darwin') === null && shortcutOf(key('n', { meta: false, control: true }), 'darwin') === null);
  check('4: away from the Mac, Control is the modifier', shortcutOf(key('f', { meta: false, control: true }), 'linux') === 'find' && shortcutOf(key('f'), 'linux') === null);
  check('4: a held key repeats the zoom only', shortcutOf(key('=', { repeat: true }), 'darwin') === 'zoom-in' && shortcutOf(key('w', { repeat: true }), 'darwin') === null && shortcutOf(key('0', { repeat: true }), 'darwin') === null);
  check('4: only a key going down counts', shortcutOf({ ...key('f'), type: 'keyUp' }, 'darwin') === null);

  // ---------- 5. Links from the chat ----------
  const on = { openChatLinksInPane: true };
  check('5: off (the default): every link goes to the default browser', chatLinkTarget('https://example.com/', { openChatLinksInPane: false }) === 'external' && chatLinkTarget('https://example.com/', undefined) === 'external');
  check('5: on: a web page opens in the pane', chatLinkTarget('https://example.com/a', on) === 'pane' && chatLinkTarget('http://localhost:3000/', on) === 'pane');
  check('5: on: other schemes still go out (mailto:, file:, an artifact, nonsense)', ['mailto:me@example.com', 'file:///etc/hosts', 'artifact://x/y', 'javascript:alert(1)', 'not a url'].every((u) => chatLinkTarget(u, on) === 'external'));

  // ---------- 6. browser_type when its own click moves the focus ----------
  const browserType = browserTools.find((t) => t.name === 'browser_type');
  const fake = (url, focusMoves) => {
    const calls = [];
    return {
      calls,
      browser: {
        state: () => ({ url, tabs: [], activeId: 'tab-1' }),
        secretValues: async () => [],
        credentialTarget: async () => null,
        pageHasPasswordField: async () => true,
        findRef: async () => 'ref_1',
        async type(ref, text, submit, clear, opts) {
          calls.push({ ref, text, opts });
          // The page's click handler puts the focus in the password field: the controller asks again and refuses
          if (focusMoves && !opts?.allowSecret) throw new Error(CREDENTIAL_REFUSAL);
          return focusMoves ? { content: 'Typed 6 characters into the password field.', secret: true } : { content: `Typed ${JSON.stringify(text)} into textbox (ref_1).`, secret: false };
        },
      },
    };
  };
  const ctxFor = (b, mode = 'bypass') => ({ browser: b, mode, cwd: '/tmp/project', config: { browser: { exempt: [], alwaysAllowed: [], sensitive: [] } }, foreground: () => true, approve: async () => ({ ok: true }), sitesAllowed: () => new Set(), signInPagesAllowed: () => new Set() });
  let fx = fake('https://fixture.example/focus.html', true);
  let r = await browserType.run({ field: 'Nickname', text: 'hunter2' }, ctxFor(fx.browser));
  check('6: on a site that is not exempt, the controller is told not to type a secret', fx.calls.length === 1 && fx.calls[0].opts && fx.calls[0].opts.allowSecret === false, fx.calls);
  check('6: … and when the focus moved into a password field the result is the refusal, the text hidden in the stored call', r.content === CREDENTIAL_REFUSAL && r.hiddenArgs && r.hiddenArgs.text === '•••', r);
  fx = fake('http://localhost:5173/focus.html', true);
  r = await browserType.run({ field: 'Nickname', text: 'hunter2' }, ctxFor(fx.browser));
  check('6: on an exempt host (the user\'s own app) the secret may be typed, and is hidden', fx.calls[0].opts.allowSecret === true && r.content.startsWith('Typed 6 characters') && r.hiddenArgs && r.hiddenArgs.text === '•••', r);
  fx = fake('https://fixture.example/focus.html', false);
  r = await browserType.run({ field: 'Nickname', text: 'Ada' }, ctxFor(fx.browser));
  check('6: a field that keeps the focus is typed into as before', r.content === 'Typed "Ada" into textbox (ref_1).' && !r.hiddenArgs, r);

  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
