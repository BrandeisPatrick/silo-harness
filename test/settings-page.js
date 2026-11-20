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
  check('fourteen sections in four groups in the navigation', nav.length === 14 && new Set(nav.map((s) => s.group)).size === 4, nav.map((s) => s.id));
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
  const manifest = { name: 'Panel', permissions: ['config:read', 'network'], contributes: { views: [{ id: 'p', title: 'P', seat: 'rail' }], looks: [{ id: 'l', title: 'L', target: 'conversation', styles: ['l.css'] }] } };
  let sheet = m.grantSheet({ state: 'off', manifest, wants: [], wantsStyles: false, granted: [] });
  check('turning on lists what the manifest asks, in words', sheet.lines.length === 2 && /Reach the internet/.test(sheet.lines[1]) && /Turn on Panel/.test(sheet.title));
  check('… with the network warning, and nothing of its look (a look asks at its first Use)', sheet.warnings.length === 1 && /leave this Mac/.test(sheet.warnings[0]));
  sheet = m.grantSheet({ state: 'paused', manifest, wants: ['network'], wantsStyles: false, granted: ['config:read'] });
  check('a paused mod lists only what is new', sheet.lines.length === 1 && /Give Panel more access\?/.test(sheet.title) && sheet.warnings.length === 1);
  const use = m.useSheet({ state: 'off', manifest: { name: 'Teal', permissions: ['session:read'] }, wants: ['session:read'], approved: false }, 'conversation');
  check('the first Use of a look: what its pages may do, that it restyles, and to trust where it came from', /Use Teal\?/.test(use.title) && use.lines.length === 1 && /restyles the conversation/.test(use.warnings[0]) && /trust where it came from/.test(use.warnings[1]));
  check('… a background says so', /draws behind the whole window/.test(m.useSheet({ state: 'off', manifest: { name: 'B' }, wants: [] }, 'background').warnings[0]));
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

  // --- looks: the versions of each kind, what is in use, the sets, the approval ---
  {
    const lk = (id, title, target, extra = {}) => ({ id, title, target, styles: ['x.css'], ...extra });
    const info = (key, name, contributes, extra = {}) => ({ key, id: key, scope: 'bundled', state: 'off', approved: true, manifest: { name, contributes }, problems: [], settings: {}, ...extra });
    const hyper = info('hyperspace', 'Hyperspace', { looks: [lk('holo', 'Holo terminal', 'conversation', { description: 'Panels' }), lk('cockpit', 'Cockpit', 'composer')], views: [{ id: 'stars', title: 'Starfield', seat: 'background', preview: 'stars.png' }] });
    const pair = info('pair', 'Pair', { looks: [lk('a', 'A', 'conversation')], views: [{ id: 'bg', title: 'Bg', seat: 'background' }] });
    const single = info('single', 'Single', { looks: [lk('only', 'Only', 'conversation')] }, { scope: 'user', approved: false });
    const broken = info('broken', 'Broken', { looks: [lk('b', 'B', 'conversation')] }, { state: 'invalid' });
    // A mod that only had styles (a theme, before themes were removed): its manifest carries nothing now
    const paper = info('paper', 'Paper theme', {});
    const mods = [hyper, pair, paper, single, broken];
    const conv = m.lookVersions(mods, 'conversation');
    check('lookVersions: Default first, then every look of the kind in list order, with its source', JSON.stringify(conv.map((v) => [v.ref, v.title, v.source])) === JSON.stringify([[null, 'Default', 'Silo Harness'], ['hyperspace/holo', 'Holo terminal', 'Hyperspace · Built-in'], ['pair/a', 'A', 'Pair · Built-in'], ['single/only', 'Only', 'Single · Yours']]) && conv[1].description === 'Panels', conv);
    const bgs = m.lookVersions(mods, 'background', '/data/backgrounds/1700-sunset.png');
    check('lookVersions: backgrounds, with your picture after Default, and the preview picture of a view', JSON.stringify(bgs.map((v) => v.ref)) === JSON.stringify([null, 'image', 'hyperspace/stars', 'pair/bg']) && bgs[1].source === 'sunset.png' && bgs[2].preview === 'stars.png', bgs);
    const L0 = { looks: { conversation: null, composer: null }, background: null, backgroundImage: null };
    check('lookInUse: per kind, your picture as "image"', m.lookInUse(L0, 'background') === null && m.lookInUse({ ...L0, backgroundImage: '/p.png' }, 'background') === 'image' && m.lookInUse({ ...L0, background: 'pair/bg', backgroundImage: '/p.png' }, 'background') === 'pair/bg' && m.lookInUse({ ...L0, looks: { conversation: 'pair/a' } }, 'conversation') === 'pair/a');
    check('needsApproval: a look of yours not approved yet; never a bundled one', m.needsApproval(single) && !m.needsApproval(hyper) && !m.needsApproval({ ...single, approved: true }));
    const sets = m.lookSets(mods);
    check('lookSets: installed mods with at least two kinds, whatever their state', sets.map((x) => x.key).join() === 'hyperspace,pair' && sets[0].background === 'hyperspace/stars' && sets[0].composer === 'hyperspace/cockpit' && !('theme' in sets[0]) && sets[1].composer === null, sets);
    check('lookSets(…, 1): every mod with a look (the chat card uses it)', m.lookSets(mods, 1).map((x) => x.key).join() === 'hyperspace,pair,single');
    const patch = m.lookSetPatch(sets[0]);
    check('lookSetPatch: the parts it has, kinds it lacks left alone', JSON.stringify(patch) === JSON.stringify({ background: 'hyperspace/stars', composer: 'hyperspace/cockpit', conversation: 'hyperspace/holo' }) && JSON.stringify(m.lookSetPatch(sets[0], false)) === JSON.stringify({ background: null, composer: null, conversation: null }) && JSON.stringify(m.lookSetPatch(null)) === '{}');
    check('setInUse: every part of it in use', m.setInUse(sets[0], { ...L0, background: 'hyperspace/stars', looks: { conversation: 'hyperspace/holo', composer: 'hyperspace/cockpit' } }) && !m.setInUse(sets[0], { ...L0, background: 'hyperspace/stars', looks: { conversation: 'pair/a', composer: 'hyperspace/cockpit' } }));
    check('isLookOnly: no panel, tab, strip, worker or command', m.isLookOnly(hyper.manifest) && !m.isLookOnly(paper.manifest) && !m.isLookOnly({ name: 'x', contributes: { views: [{ id: 'r', seat: 'rail' }], looks: [lk('a', 'A', 'composer')] } }) && !m.isLookOnly({ name: 'x' }) && !m.isLookOnly(null));
    check('modChip: a warning alone is not a problem', m.modChip({ state: 'on', problems: [{ kind: 'manifest', message: 'x', warning: true }] }) === null && m.modChip({ state: 'on', problems: [{ kind: 'runtime', message: 'x' }] }).label === 'Problem');
    check('LOOK_TABS: three kinds, each with the prompt Ask the agent starts with and the row of its head', m.LOOK_TABS.map((t) => `${t.tab}:${t.kind}:${t.row}`).join() === 'backgrounds:background:background,chat-bar:composer:look-composer,conversation:conversation:look-conversation' && m.LOOK_TABS.find((t) => t.kind === 'composer').prompt === 'Make a chat bar look that ');
  }

  // --- kinds of mod and the tabs of Settings → Mods ---
  {
    check('four tabs, Mods first, each with its kind and the New form preset', m.MOD_TABS.map((t) => `${t.id}:${t.kind}:${t.newKind}`).join() === 'mods:general:rail,backgrounds:background:background,chat-bar:composer:look:composer,conversation:conversation:look:conversation');
    check('the tabs are named in the singular', m.MOD_TABS.map((t) => t.title).join() === 'Mods,Background,Chat bar,Conversation');
    check('tab ids are recognised; Theme is gone', m.isModTab('backgrounds') && m.isModTab('chat-bar') && !m.isModTab('chatbar') && !m.isModTab('general') && !m.isModTab('themes'));
    // Every combination of the four kinds a manifest can contribute
    const parts = {
      general: [{ views: [{ id: 'r', title: 'R', seat: 'rail' }] }, { views: [{ id: 't', title: 'T', seat: 'tab' }] }, { views: [{ id: 'c', title: 'C', seat: 'composer' }] }, { commands: [{ name: 'go', description: 'Go' }] }],
      background: [{ views: [{ id: 'b', title: 'B', seat: 'background' }] }],
      composer: [{ looks: [{ id: 'k', title: 'K', target: 'composer', styles: ['k.css'] }] }],
      conversation: [{ looks: [{ id: 'v', title: 'V', target: 'conversation', styles: ['v.css'] }] }],
    };
    const order = ['general', 'background', 'composer', 'conversation'];
    const merge = (a, b) => ({ views: [...(a.views || []), ...(b.views || [])], looks: [...(a.looks || []), ...(b.looks || [])], commands: [...(a.commands || []), ...(b.commands || [])] });
    let bad = [];
    let combos = 0;
    for (let mask = 1; mask < 16; mask++) {
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
      // Mods that had only styles (themes): nothing is left of them but a general mod with nothing
      mk('midnight', {}, 'off'),
      mk('combo', { views: [{ id: 'r', title: 'R', seat: 'rail' }] }, 'on', 'user'),
    ];
    const keys = (tab) => m.modsForTab(list, tab).map((x) => x.key).join();
    check('modsForTab: Mods lists the general ones only (Hyperspace is not there)', keys('mods') === 'plan,midnight,combo', keys('mods'));
    check('modsForTab: Backgrounds, Chat bar, Conversation', keys('backgrounds') === 'hyperspace,backgrounds' && keys('chat-bar') === 'hyperspace' && keys('conversation') === 'hyperspace', [keys('backgrounds'), keys('chat-bar'), keys('conversation')]);
    check('modTabs: Hyperspace is on three tabs; a mod that only had styles on Mods', m.modTabs(list[0]).join() === 'backgrounds,chat-bar,conversation' && m.modTabs(list[3]).join() === 'mods' && m.modTabs({ manifest: { name: 'x', contributes: { styles: ['t.css'] } } }).join() === 'mods');
    check('tabOfKind: never throws, Mods for a kind that is gone', m.tabOfKind('composer') === 'chat-bar' && m.tabOfKind('general') === 'mods' && m.tabOfKind('theme') === 'mods');
    // A layout from an older profile may still hold a theme: it is not a kind any more
    const L = { looks: { conversation: null, composer: 'hyperspace/cockpit' }, background: 'backgrounds/aurora', backgroundImage: null, theme: 'paper' };
    check('choiceWords: what Appearance shows for each kind', m.choiceWords(list, L, 'background') === 'Backgrounds: Aurora' && m.choiceWords(list, L, 'composer') === 'Hyperspace: Cockpit' && m.choiceWords(list, L, 'conversation') === 'Default', [m.choiceWords(list, L, 'background'), m.choiceWords(list, L, 'composer')]);
    check('choiceWords: your picture, Default, a choice whose mod is gone', m.choiceWords(list, { ...L, background: null, backgroundImage: '/p.png' }, 'background') === 'Your picture' && m.choiceWords(list, { ...L, background: null }, 'background') === 'Default' && m.choiceWords(list, { ...L, background: 'gone/x' }, 'background') === 'gone/x (not installed)' && m.choiceWords([], null, 'background') === 'Default');
    check('a section and a tab as one target', m.sectionForTarget('mods:backgrounds') === 'mods' && m.tabForTarget('mods:backgrounds') === 'backgrounds' && m.tabForTarget('mods/chat-bar') === 'chat-bar' && m.tabForTarget('mods') === null && m.sectionForTarget('mods:nope') === null && m.tabForTarget('mods:nope') === null);
    check('refMod', m.refMod('hyperspace/holo') === 'hyperspace' && m.refMod('a@/x/y/holo') === 'a@/x/y');
  }

  // --- Settings → Models (src/renderer/settings/models-model.ts) ---------------------------------------------
  {
    check('Models: the section keeps its id and is called Models', m.SECTIONS.find((s) => s.id === 'model')?.title === 'Models' && m.isSectionId('model') && m.sectionForTarget('ollama-fields') === 'model' && m.sectionForTarget('portkey-fields') === 'model');
    const copy2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-models-page-')), 'models-model.mjs');
    fs.copyFileSync(path.join(projectDir, 'dist/renderer/settings/models-model.js'), copy2);
    const M = await import(pathToFileURL(copy2).href);
    fs.rmSync(path.dirname(copy2), { recursive: true, force: true });
    const view = (o = {}) => ({ name: 'gw', type: 'portkey', label: 'Gateway', builtIn: true, baseURL: 'http://gw.example/v1', model: 'claude-opus-5-5', models: [], contextWindow: 200000, key: 'set', keySource: 'PORTKEY_API_KEY', headers: [], ...o });
    const cat = (o = {}) => ({ name: 'gw', models: ['claude-opus-5-5', 'claude-haiku-5-5'], own: ['claude-opus-5-5'], listed: true, ...o });

    // The state in plain words
    let st = M.providerState(view(), cat(), true);
    check('state: ready, with how many models', st.label === 'Ready' && st.tone === 'ok' && st.detail === '2 models offered.', st);
    st = M.providerState(view({ key: 'missing' }), null, true);
    check('state: no key found, naming the variable (the gateway: or under Connection)', st.label === 'No key found' && /Set PORTKEY_API_KEY, or enter the key under Connection/.test(st.detail) && st.tone === 'warn', st);
    st = M.providerState(view({ name: 'groq', builtIn: false, key: 'missing', keySource: 'GROQ_API_KEY', label: 'Groq' }), cat({ noKey: true, listed: false }), false);
    check('state: a named provider without its key names its variable; not in use, it is not in colour', st.label === 'No key found' && /Set GROQ_API_KEY in your environment or in settings\.json/.test(st.detail) && st.tone === 'neutral', st);
    st = M.providerState(view({ name: 'ollama', type: 'ollama', label: 'Ollama', key: 'none' }), cat({ listed: false, unreachable: true, models: [], own: [], error: 'Could not reach Ollama at http://localhost:11434/v1. Is Ollama running? Start it with ollama serve.' }), true);
    check('state: not reachable, with the reason; red only for the provider in use', st.label === 'Not reachable' && st.tone === 'danger' && /Is Ollama running/.test(st.detail), st);
    st = M.providerState(view(), cat({ listed: false, error: 'Gateway answered 404: no route.', models: ['claude-opus-5-5'] }), true);
    check("state: can't list, says why, and that the configured model shows", st.label === "Can't list models" && /404/.test(st.detail) && /Showing the model in your settings/.test(st.detail), st);
    check('state: checking while nothing came yet', M.providerState(view(), null).label === 'Checking…');

    // The list a group shows
    const ids = M.modelIds(view({ model: 'b' }), cat({ models: ['a', 'b', 'c'] }), ['b']);
    check('modelIds: the marked model first, no repeats', ids.join() === 'b,a,c', ids);
    check('modelIds: without a list, the configured model and the entry’s list', M.modelIds(view({ model: 'x', models: ['y', 'x'] }), null).join() === 'x,y');
    const many = Array.from({ length: 300 }, (_, i) => `vendor/model-${i}`);
    let s = M.shownModels(many, '', false);
    check('shownModels: the first eight of a long list, and how many more', s.shown.length === M.MODELS_SHOWN && s.more === 292 && s.matched === 300, s.more);
    s = M.shownModels(many, '', true);
    check('shownModels: Show all shows all', s.shown.length === 300 && s.more === 0);
    s = M.shownModels(many, 'model-29', false);
    check('shownModels: a filter shows the matches', s.matched === 11 && s.shown.length === 11 && s.shown.every((x) => x.includes('model-29')), s.shown);
    s = M.shownModels(many, 'model', false);
    check('shownModels: a broad filter shows fifty, then Show all', s.shown.length === M.MATCHES_SHOWN && s.more === 250);
    s = M.shownModels(many, 'nothing-like-it', false, new Set(['vendor/model-299']));
    check('shownModels: the model in use stays whatever the filter says', s.matched === 0 && s.shown.join() === 'vendor/model-299', s);
    check('matchesModel: every word, any case', M.matchesModel('anthropic/claude-OPUS-5.5', 'opus 5.5') && !M.matchesModel('claude-haiku-5-5', 'opus'));

    // A test's words
    check('testWords: "Answered in 840 ms", "Answered in 1.2 s"', M.testWords({ ok: true, ms: 840 }).text === 'Answered in 840 ms' && M.testWords({ ok: true, ms: 1234 }).text === 'Answered in 1.2 s' && M.testWords({ ok: true, ms: 840 }).ok);
    check('testWords: the plain error as it came', M.testWords({ ok: false, ms: 3, error: 'Gateway refused the key (HTTP 401): bad key' }).text === 'Gateway refused the key (HTTP 401): bad key' && !M.testWords({ ok: false, ms: 0 }).ok && M.testWords({ ok: false, ms: 0 }).text === 'It did not answer.');
    check('rowKey: one per provider and model', M.rowKey('a', 'b:c') !== M.rowKey('a:b', 'c'));
    check('modelWords: Claude ids in words, others as they are', M.modelWords('claude-haiku-5-5') === 'Claude Haiku 5.5' && M.modelWords('@anthropic/claude-opus-5-5') === 'Claude Opus 5.5' && M.modelWords('anthropic/claude-sonnet-5.5') === 'Claude Sonnet 5.5' && M.modelWords('claude-opus-5') === 'Claude Opus 5' && M.modelWords('claude-haiku-4-5-20251001') === 'Claude Haiku 4.5' && M.modelWords('claude-sonnet-4-20250514') === 'Claude Sonnet 4' && M.modelWords('gpt-5-mini') === 'gpt-5-mini', [M.modelWords('claude-haiku-4-5-20251001'), M.modelWords('claude-sonnet-4-20250514')]);
  }
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
