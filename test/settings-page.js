// The settings page's pure pieces (src/renderer/settings/model.ts): the search matcher, the field validators, the
// config patches, the mod permission words and chips, the settings.json state chip and the schedule helpers.
// The page itself needs a DOM: it is checked live by test/live/settings-page.js. Run: node test/settings-page.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { check, done } = require('./support/check.js');

(async () => {
  // The window's modules are ES modules in a package without "type": a .mjs copy loads them without Node's warning.
  // model.js imports nothing at run time, so the copy stands alone.
  const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-settings-page-')), 'model.mjs');
  fs.copyFileSync(path.join(projectDir, 'dist/renderer/settings/model.js'), copy);
  const m = await import(pathToFileURL(copy).href);
  fs.rmSync(path.dirname(copy), { recursive: true, force: true });

  // --- sections ---------------------------------------------------------------
  const nav = m.SECTIONS.filter((s) => !s.searchOnly);
  check('thirteen sections in four groups in the navigation', nav.length === 13 && new Set(nav.map((s) => s.group)).size === 4, nav.map((s) => s.id));
  check('Scheduled and Dreaming are pages now, not sections; a search-only Pages section stands for them', !m.SECTIONS.some((s) => s.id === 'scheduled' || s.id === 'dreaming') && m.SECTIONS.filter((s) => s.searchOnly).map((s) => s.id).join() === 'pages' && !m.isSectionId('pages') && !m.isSectionId('scheduled') && JSON.stringify(m.PAGE_SECTIONS) === JSON.stringify(['scheduled', 'dreaming']));
  check('Hooks sits after Configuration files', m.SECTIONS.findIndex((s) => s.id === 'hooks') === m.SECTIONS.findIndex((s) => s.id === 'files') + 1);
  check('section ids are recognised', m.isSectionId('mods') && !m.isSectionId('nope'));
  check('old targets map to sections', m.sectionForTarget('mcp-section') === 'mcp' && m.sectionForTarget('rules-section') === 'permissions' && m.sectionForTarget('mods') === 'mods');
  check('a field id is not a section (the page looks it up)', m.sectionForTarget('ollama-baseURL') === null);

  // --- search -----------------------------------------------------------------
  check('every word must start a word of the haystack', m.matchesQuery(['API key', 'Your gateway key'], 'api k') && !m.matchesQuery(['API key'], 'pi'));
  check('case and accents do not matter', m.matchesQuery(['Résumé settings'], 'RESUME'));
  check('keywords are searched', m.matchesQuery(['Keep awake', 'Stop this Mac', 'sleep caffeinate'], 'sleep'));
  check('an empty query matches everything', m.matchesQuery(['x'], '   '));
  check('nonsense matches nothing', !m.matchesQuery(['Theme', 'System follows'], 'zqxv'));
  check('punctuation splits words', m.matchesQuery(['settings.json file'], 'json'));

  // --- validators ---------------------------------------------------------------
  let p = m.parseInteger('0', 1, 500);
  check('max tool turns 0 is refused', !p.ok && /from 1 to 500/.test(p.error), p);
  p = m.parseInteger('abc', 2048, 1048576);
  check('"abc" is not a number', !p.ok && /whole number/.test(p.error), p);
  p = m.parseInteger('16,384', 2048, 1048576);
  check('thousands separators are allowed', p.ok && p.value === 16384, p);
  check('decimals are refused for whole numbers', !m.parseInteger('12.5', 1, 100).ok);
  check('an empty number is refused', !m.parseInteger(' ', 1, 100).ok);
  p = m.parseUrl('http://localhost:11434/v1/');
  check('a URL keeps its path without the trailing slash', p.ok && p.value === 'http://localhost:11434/v1', p);
  check('a URL needs http(s)', !m.parseUrl('ftp://x').ok && !m.parseUrl('localhost:11434').ok && !m.parseUrl('').ok);
  check('text is trimmed', m.parseText('  x ').value === 'x');

  // --- config paths ---------------------------------------------------------------
  const cfg = { portkey: { model: 'a', contextWindow: 1 }, maxTurns: 40 };
  check('getPath reads nested fields', m.getPath(cfg, 'portkey.model') === 'a' && m.getPath(cfg, 'maxTurns') === 40 && m.getPath(cfg, 'x.y') === undefined);
  check('patchFor sends only the field', JSON.stringify(m.patchFor('portkey.model', 'b')) === '{"portkey":{"model":"b"}}' && JSON.stringify(m.patchFor('maxTurns', 3)) === '{"maxTurns":3}');
  check('the permission mode keeps the legacy flag in step', JSON.stringify(m.patchFor('permissionMode', 'bypass')) === '{"permissionMode":"bypass","autoApprove":true}');
  check('compact steps: nearest offered value', m.nearestCompactStep(0.82) === 0.8 && m.nearestCompactStep(0.93) === 0.95 && m.nearestCompactStep('x') === 0.8);

  // --- mods ---------------------------------------------------------------------
  check('every permission has plain words', ['session:read', 'session:send', 'session:control', 'sessions:read', 'model', 'skills:read', 'config:read', 'config:write', 'schedules', 'remote', 'network'].every((k) => m.PERMISSION_WORDS[k] && m.PERMISSION_WORDS[k] !== k));
  check('chips: off, paused, invalid, problems, on', m.modChip({ state: 'off', problems: [] }).label === 'Off' && /Paused/.test(m.modChip({ state: 'paused', problems: [] }).label) && m.modChip({ state: 'invalid', problems: [] }).label === 'Problem' && m.modChip({ state: 'on', problems: [{}] }).label === 'Problem' && m.modChip({ state: 'on', problems: [] }) === null);
  const manifest = { name: 'Theme', permissions: ['config:read', 'network'], contributes: { styles: ['theme.css'] } };
  let sheet = m.grantSheet({ state: 'off', manifest, wants: [], wantsStyles: false, granted: [] });
  check('turning on lists what the manifest asks, in words', sheet.lines.length === 2 && /Reach the internet/.test(sheet.lines[1]) && /Turn on Theme/.test(sheet.title));
  check('… with the restyle and network warnings', sheet.warnings.length === 2 && /restyle the whole app/.test(sheet.warnings[0]) && /leave this Mac/.test(sheet.warnings[1]));
  sheet = m.grantSheet({ state: 'paused', manifest, wants: ['network'], wantsStyles: false, granted: ['config:read'] });
  check('a paused mod lists only what is new', sheet.lines.length === 1 && /wants more access/.test(sheet.title) && sheet.warnings.length === 1);
  check('a mod id from a name', m.deriveModId('Word count!') === 'word-count' && m.deriveModId('9 lives') === 'lives' && m.deriveModId('x') === 'x-mod' && m.deriveModId('') === '');
  check('mod ids are validated like the manifest', m.validModId('word-count') && !m.validModId('Word') && !m.validModId('a') && !m.validModId('1abc'));
  check('an SVG icon file is used as is; names and paths out are not', m.modIconFile('icon.svg') === 'icon.svg' && m.modIconFile('gauge') === null && m.modIconFile('../x.svg') === null);

  // --- settings.json state chip -------------------------------------------------------
  const f = (o) => ({ scope: 'project', path: '/p', exists: true, applied: false, trusted: false, keys: [], invalid: [], ...o });
  check('file states', m.fileState(f({ exists: false })).label === 'Not found' && m.fileState(f({ error: 'bad' })).label === 'Could not be read' && m.fileState(f({ changed: true, trusted: true })).label === 'Changed since you approved it' && m.fileState(f({})).label === 'Needs your approval' && m.fileState(f({ trusted: true, applied: true })).label === 'Applied' && m.fileState(f({ scope: 'user', applied: true, trusted: true })).label === 'Applied');

  // --- schedules -------------------------------------------------------------------
  let iso = m.localToIso('2026-11-06T09:00', 300);
  check('a local time gets its offset', iso.ok && iso.value === '2026-11-06T09:00:00-05:00', iso);
  iso = m.localToIso('2026-11-06T09:30', -330);
  check('… east of UTC too', iso.ok && iso.value === '2026-11-06T09:30:00+05:30', iso);
  check('a bad date is refused', !m.localToIso('tomorrow').ok);
  const base = new Date(2026, 10, 5, 12, 0).getTime();
  check('once: in the future only', !m.parseWhen('at', '2026-11-05T11:00', base).ok && m.parseWhen('at', '2026-11-05T13:00', base).value.kind === 'at');
  check('every: at least 5 minutes', !m.parseWhen('every', '2').ok && m.parseWhen('every', '30').value.minutes === 30);
  check('cron: five fields', m.parseWhen('cron', ' 0 9  * * 1-5 ').value.expr === '0 9 * * 1-5' && !m.parseWhen('cron', '0 9 * *').ok);
  check('dates in words', m.formatWhenAt(new Date(2026, 10, 5, 9, 5).getTime(), base) === 'Today at 09:05' && m.formatWhenAt(new Date(2026, 10, 6, 14, 0).getTime(), base) === 'Tomorrow at 14:00' && m.formatWhenAt(new Date(2026, 11, 24, 8, 0).getTime(), base) === 'Dec 24 at 08:00');
  check('relative days', m.relativeDays(base + 3 * 86400000, base) === 'in 3 days' && m.relativeDays(base - 3600000, base) === '1 hour ago');

  // --- looks: the region selects, the sets, which set the layout shows, the patch a set makes ---
  {
    const lk = (id, title, target) => ({ id, title, target, styles: ['x.css'] });
    const info = (key, name, contributes, state = 'on') => ({ key, id: key, scope: 'bundled', state, manifest: { name, contributes }, problems: [], settings: {} });
    const hyper = info('hyperspace', 'Hyperspace', { looks: [lk('holo', 'Holo terminal', 'conversation'), lk('cockpit', 'Cockpit', 'composer')], views: [{ id: 'stars', title: 'Hyperspace', seat: 'background' }] });
    const pair = info('pair', 'Pair', { looks: [lk('a', 'A', 'conversation')], views: [{ id: 'bg', title: 'Bg', seat: 'background' }] });
    const single = info('single', 'Single', { looks: [lk('only', 'Only', 'conversation')] });
    const off = info('offset', 'Off set', { looks: [lk('a', 'A', 'conversation'), lk('b', 'B', 'composer')] }, 'off');
    const mods = [hyper, pair, single, off];
    check('lookChoices: every look for the region from on mods, named "<mod>: <look>"', JSON.stringify(m.lookChoices(mods, 'conversation')) === JSON.stringify([{ value: 'hyperspace/holo', label: 'Hyperspace: Holo terminal' }, { value: 'pair/a', label: 'Pair: A' }, { value: 'single/only', label: 'Single: Only' }]) && m.lookChoices(mods, 'composer').length === 1);
    const sets = m.lookSets(mods);
    check('lookSets: on mods with at least two of the three parts', sets.map((x) => x.key).join() === 'hyperspace,pair' && sets[0].background === 'hyperspace/stars' && sets[0].composer === 'hyperspace/cockpit' && sets[1].composer === null, sets);
    const L0 = { looks: { conversation: null, composer: null }, background: null, backgroundImage: null };
    check('currentLookSet: None when everything is the app\'s own', m.currentLookSet(mods, L0) === '');
    check('currentLookSet: a set when the three are exactly its parts', m.currentLookSet(mods, { ...L0, looks: { conversation: 'hyperspace/holo', composer: 'hyperspace/cockpit' }, background: 'hyperspace/stars' }) === 'hyperspace');
    check('currentLookSet: a set lacking a part needs that part to be the app\'s own', m.currentLookSet(mods, { ...L0, looks: { conversation: 'pair/a', composer: null }, background: 'pair/bg' }) === 'pair' && m.currentLookSet(mods, { ...L0, looks: { conversation: 'pair/a', composer: 'hyperspace/cockpit' }, background: 'pair/bg' }) === 'custom');
    check('currentLookSet: Custom for a mix, or a user picture under a set', m.currentLookSet(mods, { ...L0, looks: { conversation: 'single/only', composer: null }, background: null }) === 'custom' && m.currentLookSet(mods, { ...L0, looks: { conversation: 'pair/a', composer: null }, backgroundImage: '/x.png' }) === 'custom' && m.currentLookSet(mods, { ...L0, backgroundImage: '/x.png' }) === 'custom');
    check('currentLookSet: "off:<key>" when all the parts come from a mod that is off or gone', m.currentLookSet(mods, { ...L0, looks: { conversation: 'offset/a', composer: 'offset/b' } }) === 'off:offset' && m.currentLookSet(mods, { ...L0, looks: { conversation: 'gone/a', composer: null }, background: 'gone/bg' }) === 'off:gone');
    check('currentLookSet: one part of an off mod alone is Custom', m.currentLookSet(mods, { ...L0, looks: { conversation: 'offset/a', composer: null } }) === 'custom');
    check('lookSetPatch: a set sets all three, a missing part to the app\'s own', JSON.stringify(m.lookSetPatch(sets[0])) === JSON.stringify({ looks: { conversation: 'hyperspace/holo', composer: 'hyperspace/cockpit' }, background: 'hyperspace/stars' }) && m.lookSetPatch(sets[1]).looks.composer === null);
    const none = m.lookSetPatch(null);
    check('lookSetPatch: None clears the looks, the background and the picture', none.looks.conversation === null && none.looks.composer === null && none.background === null && none.backgroundImage === null);
    check('a patch applied gives back the set', m.currentLookSet(mods, { ...L0, ...m.lookSetPatch(sets[0]) }) === 'hyperspace' && m.currentLookSet(mods, { ...L0, ...m.lookSetPatch(sets[1]) }) === 'pair');
    check('offLookMods: the off mods that have looks', m.offLookMods(mods).join() === 'Off set');
    check('modChip: a warning alone is not a problem', m.modChip({ state: 'on', problems: [{ kind: 'manifest', message: 'x', warning: true }] }) === null && m.modChip({ state: 'on', problems: [{ kind: 'runtime', message: 'x' }] }).label === 'Problem');
    check('grantSheet: looks get the restyle warning', /restyle the whole app/.test(m.grantSheet({ state: 'off', manifest: { name: 'L', contributes: { looks: [lk('a', 'A', 'conversation')] } }, wants: [], wantsStyles: false, granted: [] }).warnings[0] || ''));
  }

  // --- kinds of mod and the tabs of Settings → Mods ---
  {
    check('five tabs, Mods first, each with its kind and the New form preset', m.MOD_TABS.map((t) => `${t.id}:${t.kind}:${t.newKind}`).join() === 'mods:general:rail,backgrounds:background:background,chat-bar:composer:look:composer,conversation:conversation:look:conversation,themes:theme:theme');
    check('tab ids are recognised', m.isModTab('backgrounds') && m.isModTab('chat-bar') && !m.isModTab('chatbar') && !m.isModTab('general'));
    // Every combination of the five kinds a manifest can contribute
    const parts = {
      general: [{ views: [{ id: 'r', title: 'R', seat: 'rail' }] }, { views: [{ id: 't', title: 'T', seat: 'tab' }] }, { views: [{ id: 'c', title: 'C', seat: 'composer' }] }, { commands: [{ name: 'go', description: 'Go' }] }],
      background: [{ views: [{ id: 'b', title: 'B', seat: 'background' }] }],
      composer: [{ looks: [{ id: 'k', title: 'K', target: 'composer', styles: ['k.css'] }] }],
      conversation: [{ looks: [{ id: 'v', title: 'V', target: 'conversation', styles: ['v.css'] }] }],
      theme: [{ styles: ['theme.css'] }],
    };
    const order = ['general', 'background', 'composer', 'conversation', 'theme'];
    const merge = (a, b) => ({ views: [...(a.views || []), ...(b.views || [])], looks: [...(a.looks || []), ...(b.looks || [])], commands: [...(a.commands || []), ...(b.commands || [])], styles: [...(a.styles || []), ...(b.styles || [])] });
    let bad = [];
    let combos = 0;
    for (let mask = 1; mask < 32; mask++) {
      const want = order.filter((_, i) => mask & (1 << i));
      // each general way on its own, and every way together
      const variants = want.includes('general') ? [...parts.general.map((g) => [g]), parts.general] : [[]];
      for (const gen of variants) {
        let c = {};
        for (const g of gen) c = merge(c, g);
        for (const k of want) if (k !== 'general') c = merge(c, parts[k][0]);
        const got = m.modKinds({ name: 'x', contributes: c });
        combos++;
        if (got.join() !== want.join()) bad.push({ want, got, c });
      }
    }
    check(`modKinds: every combination of kinds, in tab order (${combos} manifests)`, bad.length === 0, bad.slice(0, 3));
    check('modKinds: a mod that contributes nothing, or has no manifest, is general', m.modKinds({ name: 'x' }).join() === 'general' && m.modKinds({ name: 'x', contributes: { settings: [{ key: 'a', type: 'boolean', title: 'A' }] } }).join() === 'general' && m.modKinds(null).join() === 'general' && m.modKinds({ name: 'x', contributes: { views: [], looks: [], styles: [], commands: [] } }).join() === 'general');
    check('modKinds: two backgrounds are still one kind', m.modKinds({ name: 'x', contributes: { views: [{ id: 'a', seat: 'background' }, { id: 'b', seat: 'background' }] } }).join() === 'background');
    const mk = (key, contributes, state = 'on', scope = 'bundled') => ({ key, id: key, scope, state, manifest: { name: key[0].toUpperCase() + key.slice(1), contributes }, problems: [], settings: {} });
    const list = [
      mk('hyperspace', { looks: [{ id: 'holo', title: 'Holo', target: 'conversation', styles: ['a.css'] }, { id: 'cockpit', title: 'Cockpit', target: 'composer', styles: ['b.css'] }], views: [{ id: 'starfield', title: 'Starfield', seat: 'background' }] }),
      mk('plan', { views: [{ id: 'p', title: 'Plan', seat: 'rail' }] }),
      mk('backgrounds', { views: [{ id: 'aurora', title: 'Aurora', seat: 'background' }] }),
      mk('midnight', { styles: ['theme.css'] }, 'off'),
      mk('paper', { styles: ['theme.css'] }, 'on', 'user'),
      mk('combo', { views: [{ id: 'r', title: 'R', seat: 'rail' }], styles: ['x.css'] }, 'on', 'user'),
    ];
    const keys = (tab) => m.modsForTab(list, tab).map((x) => x.key).join();
    check('modsForTab: Mods lists the general ones only (Hyperspace is not there)', keys('mods') === 'plan,combo', keys('mods'));
    check('modsForTab: Backgrounds, Chat bar, Conversation, Themes', keys('backgrounds') === 'hyperspace,backgrounds' && keys('chat-bar') === 'hyperspace' && keys('conversation') === 'hyperspace' && keys('themes') === 'midnight,paper,combo', [keys('backgrounds'), keys('chat-bar'), keys('conversation'), keys('themes')]);
    check('modTabs: Hyperspace is on three tabs; a rail panel with styles on two', m.modTabs(list[0]).join() === 'backgrounds,chat-bar,conversation' && m.modTabs(list[5]).join() === 'mods,themes');
    check('themeMods: in list order (the order the styles apply)', m.themeMods(list).map((x) => x.key).join() === 'midnight,paper,combo');
    check('tabOfKind', m.tabOfKind('composer') === 'chat-bar' && m.tabOfKind('general') === 'mods' && m.tabOfKind('theme') === 'themes');
    check('backgroundChoices: from mods that are on', JSON.stringify(m.backgroundChoices(list)) === JSON.stringify([{ value: 'hyperspace/starfield', label: 'Hyperspace: Starfield' }, { value: 'backgrounds/aurora', label: 'Backgrounds: Aurora' }]));
    const L = { looks: { conversation: null, composer: 'hyperspace/cockpit' }, background: 'backgrounds/aurora', backgroundImage: null };
    check('choiceWords: what Appearance shows for each kind', m.choiceWords(list, L, 'background') === 'Backgrounds: Aurora' && m.choiceWords(list, L, 'composer') === 'Hyperspace: Cockpit' && m.choiceWords(list, L, 'conversation') === 'Default' && m.choiceWords(list, L, 'theme') === 'Paper, Combo', [m.choiceWords(list, L, 'background'), m.choiceWords(list, L, 'theme')]);
    check('choiceWords: your picture, nothing, a choice whose mod is gone', m.choiceWords(list, { ...L, background: null, backgroundImage: '/p.png' }, 'background') === 'Your picture' && m.choiceWords(list, { ...L, background: null }, 'background') === 'None' && m.choiceWords(list, { ...L, background: 'gone/x' }, 'background') === 'gone/x (off)' && m.choiceWords([], null, 'theme') === 'None');
    check('offModsOfTab: the off mods of a tab', m.offModsOfTab(list, 'themes').join() === 'Midnight' && m.offModsOfTab(list, 'backgrounds').length === 0);
    check('a section and a tab as one target', m.sectionForTarget('mods:backgrounds') === 'mods' && m.tabForTarget('mods:backgrounds') === 'backgrounds' && m.tabForTarget('mods/chat-bar') === 'chat-bar' && m.tabForTarget('mods') === null && m.sectionForTarget('mods:nope') === null && m.tabForTarget('mods:nope') === null);
    check('refMod', m.refMod('hyperspace/holo') === 'hyperspace' && m.refMod('a@/x/y/holo') === 'a@/x/y');
  }
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
