// The mod host's pure parts (src/renderer/mods/logic.ts): ordering views per seat, layout clamping, the permission
// checks for methods and events, mapping agent events to mod events, the hello, and the "turn on" card's wording.
// Run: node test/mods-host.js (after npm run build)
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, done } = require('./support/check.js');

const projectDir = process.argv[2] || path.join(__dirname, '..');

// The renderer is compiled as ES modules without "type": "module"; Node's note about reparsing it is noise here.
process.emitWarning = () => {};

(async () => {
  const L = await import(pathToFileURL(path.join(projectDir, 'dist/renderer/mods/logic.js')).href);
  const { MOD_METHOD_PERMISSIONS, MOD_EVENT_PERMISSIONS } = require(path.join(projectDir, 'dist/main/mods/permissions.js'));

  const mod = (key, views, extra = {}) => ({
    key,
    id: key,
    scope: 'user',
    dir: `/Users/me/.silo-harness/mods/${key}`,
    manifest: { protocol: 1, id: key, name: key.toUpperCase(), version: '1.0.0', permissions: extra.permissions ?? [], contributes: { views, ...(extra.contributes ?? {}) } },
    state: extra.state ?? 'on',
    granted: extra.granted ?? extra.permissions ?? [],
    wants: extra.wants ?? [],
    wantsStyles: !!extra.wantsStyles,
    problems: [],
    rev: extra.rev ?? 'r1',
    origin: `mod://${key}.user`,
    settings: { a: 1 },
  });
  const v = (id, seat, title, order) => ({ id, seat, title, entry: `${id}.html`, ...(order !== undefined ? { order } : {}) });

  // --- views per seat, ordering ---
  {
    const mods = [
      mod('zeta', [v('main', 'rail', 'Zeta', 10), v('t', 'tab', 'Zeta tab')]),
      mod('alpha', [v('main', 'rail', 'Alpha')]),
      mod('beta', [v('main', 'rail', 'Beta', 10)]),
      mod('off', [v('main', 'rail', 'Off', 1)], { state: 'off' }),
      mod('paused', [v('main', 'rail', 'Paused', 1)], { state: 'paused' }),
      mod('gamma', [v('main', 'rail', 'Aardvark')]),
      mod('strip', [v('s', 'composer', 'Strip')]),
      mod('bg', [v('b', 'background', 'Bg')]),
    ];
    const rail = L.viewsFor(mods, 'rail').map((r) => r.key);
    check('rail: on mods only, by order then title (default order 100)', JSON.stringify(rail) === JSON.stringify(['beta/main', 'zeta/main', 'gamma/main', 'alpha/main']), rail);
    check('tab seat', JSON.stringify(L.viewsFor(mods, 'tab').map((r) => r.key)) === '["zeta/t"]');
    check('composer seat', L.viewsFor(mods, 'composer').length === 1 && L.viewsFor(mods, 'composer')[0].view.id === 's');
    check('background: only the one the layout names', L.activeBackground(mods, { background: 'bg/b' })?.key === 'bg/b' && L.activeBackground(mods, { background: 'zeta/main' }) === null && L.activeBackground(mods, { background: null }) === null);
    check('background of a mod that is off is not active', L.activeBackground([mod('bg', [v('b', 'background', 'Bg')], { state: 'off' })], { background: 'bg/b' }) === null);
    check('viewKey', L.viewKey('a@/p', 'main') === 'a@/p/main');
  }

  // --- layout and sizes ---
  {
    check('rail width clamps to 240..480', L.clampRailWidth(100) === 240 && L.clampRailWidth(999) === 480 && L.clampRailWidth(333.4) === 333 && L.clampRailWidth('x') === 300);
    check('rail frame height: up to maxHeight, default 360', L.frameHeight('rail', 500) === 360 && L.frameHeight('rail', 500, 420) === 420 && L.frameHeight('rail', 120.2, 420) === 121 && L.frameHeight('rail', -5) === 0);
    check('composer frame height: up to 120', L.frameHeight('composer', 300) === 120 && L.frameHeight('composer', 44) === 44);
    const c = L.setCollapsed(['a/m'], 'b/m', true);
    check('collapsed: add, no duplicates, remove', JSON.stringify(c) === '["a/m","b/m"]' && JSON.stringify(L.setCollapsed(c, 'b/m', true)) === '["a/m","b/m"]' && JSON.stringify(L.setCollapsed(c, 'a/m', false)) === '["b/m"]');
    check('frame src: entry encoded, rev as v', L.frameSrc({ origin: 'mod://x.user', rev: 'ab c' }, './pages/my panel.html') === 'mod://x.user/pages/my%20panel.html?v=ab%20c');
    check('mod signature changes with rev and grant, not settings', L.modSignature(mod('a', [])) !== L.modSignature(mod('a', [], { rev: 'r2' })) && L.modSignature(mod('a', [])) !== L.modSignature(mod('a', [], { granted: ['session:read'] })) && L.modSignature(mod('a', [])) === L.modSignature({ ...mod('a', []), settings: { a: 2 } }));
  }

  // --- permissions ---
  {
    const reader = mod('r', [], { permissions: ['session:read'] });
    const none = mod('n', []);
    check('unknown method is undefined, ui.* needs nothing, session.get needs session:read', L.methodNeeds(MOD_METHOD_PERMISSIONS, 'nope') === undefined && L.methodNeeds(MOD_METHOD_PERMISSIONS, 'ui.toast') === null && L.methodNeeds(MOD_METHOD_PERMISSIONS, 'session.get') === 'session:read');
    check('holds: on and granted', L.holds(reader, 'session:read') && !L.holds(none, 'session:read') && L.holds(none, null) && !L.holds({ ...reader, state: 'paused' }, 'session:read'));
    check('mayReceive: unknown events never, permitted ones only', !L.mayReceive(MOD_EVENT_PERMISSIONS, reader, 'made.up') && L.mayReceive(MOD_EVENT_PERMISSIONS, reader, 'tasks.changed') && !L.mayReceive(MOD_EVENT_PERMISSIONS, none, 'tasks.changed') && L.mayReceive(MOD_EVENT_PERMISSIONS, none, 'theme.changed') && L.mayReceive(MOD_EVENT_PERMISSIONS, none, 'session.switched'));
    check('subscribe: unknown names accepted, a missing permission named', L.subscribeMissing(MOD_EVENT_PERMISSIONS, none, ['made.up', 'theme.changed']) === null && L.subscribeMissing(MOD_EVENT_PERMISSIONS, none, ['theme.changed', 'run.ended']) === 'session:read' && L.subscribeMissing(MOD_EVENT_PERMISSIONS, none, ['skills.used']) === 'skills:read');
    const windowSide = Object.keys(MOD_METHOD_PERMISSIONS).filter(L.isWindowMethod).sort();
    const { isWindowMethod: mainSide } = require(path.join(projectDir, 'dist/main/mods/permissions.js'));
    check('the window and the main process agree on the window methods', JSON.stringify(Object.keys(MOD_METHOD_PERMISSIONS).filter(mainSide).sort()) === JSON.stringify(windowSide));
    check('window methods match the brief', JSON.stringify(windowSide) === JSON.stringify(['composer.insert', 'events.subscribe', 'events.unsubscribe', 'hello', 'hooks.subscribe', 'hooks.unsubscribe', 'log.error', 'outputs.open', 'sessions.create', 'sessions.open', 'ui.copy', 'ui.markdown', 'ui.open', 'ui.openExternal', 'ui.openPage', 'ui.openSettings', 'ui.resize', 'ui.setBadge', 'ui.setTitle', 'ui.theme', 'ui.toast']), windowSide);
    check('http(s) only for openExternal', L.isHttpUrl('https://a.b/x') && L.isHttpUrl('http://a') && !L.isHttpUrl('file:///etc/passwd') && !L.isHttpUrl('javascript:alert(1)') && !L.isHttpUrl('mod://x/y') && !L.isHttpUrl(3));
  }

  // --- hello ---
  {
    const m = mod('w', [v('main', 'rail', 'W')], { permissions: ['session:read'] });
    const theme = { scheme: 'dark', tokens: { '--bg-100': '#262624' } };
    const h = L.buildHello(m, m.manifest.contributes.views[0], { name: 'Silo Harness', version: '0.1.0' }, theme, true);
    check('hello: protocol 1, mod, view, app, grant, theme, settings, visible', h.protocol === 1 && h.mod.id === 'w' && h.mod.name === 'W' && h.mod.scope === 'user' && h.view.seat === 'rail' && h.app.name === 'Silo Harness' && h.granted[0] === 'session:read' && h.theme.tokens['--bg-100'] === '#262624' && h.settings.a === 1 && h.visible === true, h);
    h.granted.push('model');
    check('hello: a copy, not the live grant', m.granted.length === 1);
  }

  // --- agent events → mod events ---
  {
    const map = (ev) => L.eventsFromAgent(ev, 's1');
    const one = (ev) => map(ev)[0];
    check('run_start → run.started', JSON.stringify(one({ type: 'run_start' })) === JSON.stringify({ name: 'run.started', data: { sessionId: 's1' } }));
    check('run_end → run.ended with reason and text', JSON.stringify(one({ type: 'run_end', reason: 'done', text: 'ok' }).data) === JSON.stringify({ sessionId: 's1', reason: 'done', text: 'ok' }));
    check('user_message → message.user', JSON.stringify(one({ type: 'user_message', text: 'hi', images: 0, origin: 'user' })) === JSON.stringify({ name: 'message.user', data: { text: 'hi', origin: 'user' } }));
    check('assistant_message → message.assistant', one({ type: 'assistant_message', text: 'yo', toolCalls: 0 }).name === 'message.assistant');
    check('text_delta → message.delta', JSON.stringify(one({ type: 'text_delta', text: 'a' })) === JSON.stringify({ name: 'message.delta', data: { text: 'a' } }));
    check('tool_start → tool.started', JSON.stringify(one({ type: 'tool_start', id: 't', name: 'bash', args: { c: 1 } }).data) === JSON.stringify({ id: 't', name: 'bash', args: { c: 1 } }));
    check('tool_end → tool.ended without the result', JSON.stringify(one({ type: 'tool_end', id: 't', name: 'bash', result: 'secret output', ok: true, durationMs: 5 }).data) === JSON.stringify({ id: 't', name: 'bash', ok: true, durationMs: 5 }));
    check('tasks_updated → tasks.changed', one({ type: 'tasks_updated', tasks: [{ id: '1', title: 'x', status: 'pending' }] }).data.tasks.length === 1);
    check('plan_proposed → plan.changed', one({ type: 'plan_proposed', plan: { id: 'p' } }).name === 'plan.changed');
    check('artifact, image, changes → outputs.changed', ['artifact', 'image', 'changes_updated'].every((type) => one({ type }).name === 'outputs.changed'));
    check('context → context.changed { tokens, limit }', JSON.stringify(one({ type: 'context', context: { tokens: 5, limit: 10, threshold: 0.8, autoCompact: true } }).data) === JSON.stringify({ tokens: 5, limit: 10 }));
    check('thinking, usage, approvals map to nothing', ['thinking_delta', 'usage', 'approval_request', 'queue_delivered', 'error'].every((type) => map({ type }).length === 0));
  }

  // --- sessions ---
  {
    const meta = { id: 's', title: 'T', createdAt: 1, updatedAt: 2, messageCount: 3, status: { running: true, attention: 'approval' } };
    const s = L.toModSession(meta, '/cwd');
    check('toModSession fills cwd, origin, state', s.cwd === '/cwd' && s.origin === 'user' && s.running && s.attention === 'approval' && !('parentId' in s));
    check('toModSession: the window says whether it runs', L.toModSession(meta, '/cwd', false).running === false);
    check('session signature follows title and state', L.sessionSignature(s) !== L.sessionSignature({ ...s, title: 'U' }) && L.sessionSignature(s) === L.sessionSignature({ ...s, updatedAt: 9 }));
    const list = [{ id: 'a', title: 'A', messageCount: 1, updatedAt: 1 }, { id: 'b', title: 'B', parentId: 'a', messageCount: 1, updatedAt: 1 }, { id: 'c', title: 'C', messageCount: 1, updatedAt: 1 }];
    check('related signature: none without relatives', L.relatedSignature(list, 'c') === '');
    const before = L.relatedSignature(list, 'a');
    const after = L.relatedSignature([list[0], { ...list[1], status: { running: true } }, list[2]], 'a');
    check('related signature changes when a child changes state', before && after && before !== after);
    check('related signature from the child sees the parent', L.relatedSignature(list, 'b') !== '');
  }

  // --- the card's words ---
  {
    const lines = L.askLines(mod('n', [v('m', 'rail', 'N')], { state: 'off', permissions: ['session:read', 'network'] }));
    check('asks: plain words per permission and a strong network line', lines.some((l) => /Read the session on screen/.test(l.text)) && lines.some((l) => l.strong && /internet/.test(l.text) && /send/.test(l.text)), lines);
    const st = L.askLines(mod('s', [], { state: 'off', contributes: { styles: ['t.css'] } }));
    check('asks: styles (themes, removed) are not said to restyle anything', !st.some((l) => /restyle/.test(l.text)), st);
    const bg = L.askLines(mod('b', [v('b', 'background', 'B')], { state: 'off' }));
    check('asks: a background gets a clear line', bg.some((l) => l.strong && /behind the whole window/.test(l.text)), bg);
    const paused = L.askLines(mod('p', [v('m', 'rail', 'P')], { state: 'paused', permissions: ['session:read', 'model'], granted: ['session:read'], wants: ['model'] }));
    check('asks: a paused mod lists only what it wants now', paused.length === 1 && /model/.test(paused[0].text), paused);
    check('asks: nothing at all is said plainly', /Nothing beyond its own panel/.test(L.askLines(mod('z', [v('m', 'rail', 'Z')], { state: 'off' }))[0].text));
    check('shortDir uses ~ under home only', L.shortDir('/Users/me/.silo-harness/mods/x', '/Users/me') === '~/.silo-harness/mods/x' && L.shortDir('/Users/meow/x', '/Users/me') === '/Users/meow/x');
    const builtin = (n) => ['gauge', 'list'].includes(n);
    check('icons: built-in, an SVG in the mod, or nothing', L.iconSource('gauge', 'mod://a.user', builtin).builtin === 'gauge' && L.iconSource('img/i.svg', 'mod://a.user', builtin).url === 'mod://a.user/img/i.svg' && L.iconSource('../x.svg', 'mod://a.user', builtin) === null && L.iconSource('nope', 'mod://a.user', builtin) === null && L.iconSource('https://e.com/i.svg', 'mod://a.user', builtin) === null);
  }

  // --- looks: the active one per region, the state attributes, the pointer, the card's words ---
  {
    const looks = [{ id: 'holo', title: 'Holo', target: 'conversation', styles: ['a.css'] }, { id: 'bar', title: 'Bar', target: 'composer', styles: ['b.css'] }];
    const set = mod('set', [], { contributes: { looks } });
    const offSet = mod('offset', [], { state: 'off', contributes: { looks } });
    const lay = { looks: { conversation: 'set/holo', composer: 'set/holo' } };
    check('activeLook: the chosen look of an on mod, for its own region only', L.activeLook([set], lay, 'conversation')?.id === 'holo' && L.activeLook([set], lay, 'composer') === null);
    check('activeLook: none for an off mod, a missing mod, or no choice', L.activeLook([offSet], { looks: { conversation: 'offset/holo' } }, 'conversation') === null && L.activeLook([set], { looks: { conversation: 'gone/holo' } }, 'conversation') === null && L.activeLook([set], { looks: { conversation: null } }, 'conversation') === null && L.activeLook([set], {}, 'conversation') === null);
    const proj = mod('p@/Users/me/code/app', [], { contributes: { looks } });
    check('activeLook: a project mod key with "/" in it', L.activeLook([proj], { looks: { conversation: 'p@/Users/me/code/app/holo' } }, 'conversation')?.mod === proj);
    const attrs = L.lookAttributes({ ref: 'set/holo', running: true, scheme: 'dark', mode: 'auto', settings: { glow: 'green', motion: 'calm', 'Odd Key!': 3, on: false, obj: { a: 1 } } });
    check('lookAttributes: data-look, data-running, data-scheme, data-mode', attrs['data-look'] === 'set/holo' && attrs['data-running'] === 'true' && attrs['data-scheme'] === 'dark' && attrs['data-mode'] === 'auto', attrs);
    check('lookAttributes: one data-set-<key> per setting, lower case, values as text, objects left out', attrs['data-set-glow'] === 'green' && attrs['data-set-motion'] === 'calm' && attrs['data-set-odd-key-'] === '3' && attrs['data-set-on'] === 'false' && !('data-set-obj' in attrs), attrs);
    check('lookAttributes: not running is "false"', L.lookAttributes({ ref: 'a/b', running: false, scheme: 'light', mode: 'ask', settings: {} })['data-running'] === 'false');
    check('pointerFraction: fractions of the window, clamped', JSON.stringify(L.pointerFraction(720, 225, 1440, 900)) === '{"x":0.5,"y":0.25}' && JSON.stringify(L.pointerFraction(-5, 2000, 1440, 900)) === '{"x":0,"y":1}' && JSON.stringify(L.pointerFraction(10, 10, 0, 0)) === '{"x":0.5,"y":0.5}');
    check('pointer is always available, like theme.changed', MOD_EVENT_PERMISSIONS.pointer === null && L.mayReceive(MOD_EVENT_PERMISSIONS, mod('none', []), 'pointer'));
    check('LOOK_TARGETS', L.LOOK_TARGETS.join() === 'conversation,composer');
    const asks = L.askLines(mod('lk', [], { state: 'off', contributes: { looks } }));
    check('asks: a mod with looks gets a clear restyle line', asks.some((l) => l.strong && /restyle the conversation or the chat bar/.test(l.text)), asks);
    const asksBg = L.askLines(mod('lk', [v('bg', 'background', 'Bg')], { state: 'off', contributes: { looks } }));
    check('asks: looks and a background together', asksBg.some((l) => l.strong && /restyle the conversation or the chat bar and draw behind the window/.test(l.text)), asksBg);
  }

  // --- hooks: which views a hook request goes to, and what counts as a decision ---
  {
    const hm = mod('hk', [v('panel', 'rail', 'Panel'), v('worker', 'worker', 'Worker'), v('tab', 'tab', 'Tab')], { permissions: ['hooks'], contributes: { hooks: [{ event: 'PreToolUse' }] } });
    const frames = [
      { view: 'tab', hooks: new Set(['PreToolUse']) },
      { view: 'worker', hooks: new Set(['PreToolUse', 'Stop']) },
      { view: 'panel', hooks: new Set(['Stop']) },
    ];
    check('hooks: only the views that registered for the event, in the order the manifest lists them', JSON.stringify(L.hookViewOrder(hm, frames, 'PreToolUse').map((f) => f.view)) === '["worker","tab"]' && JSON.stringify(L.hookViewOrder(hm, frames, 'Stop').map((f) => f.view)) === '["panel","worker"]');
    check('hooks: no registered view, no request', L.hookViewOrder(hm, frames, 'SessionEnd').length === 0);
    check('hooks: null, undefined and {} decide nothing; anything else is an answer', L.isEmptyHookResult(null) && L.isEmptyHookResult(undefined) && L.isEmptyHookResult({}) && !L.isEmptyHookResult({ decision: 'block' }));
    check('hooks: the worker seat is a seat of its own', L.viewsFor([hm], 'worker').map((r) => r.key).join() === 'hk/worker' && L.viewsFor([hm], 'rail').length === 1);
    check('hooks: the hooks.* methods need the hooks permission and are the window\'s', MOD_METHOD_PERMISSIONS['hooks.subscribe'] === 'hooks' && MOD_METHOD_PERMISSIONS['hooks.unsubscribe'] === 'hooks' && L.isWindowMethod('hooks.subscribe') && L.methodNeeds(MOD_METHOD_PERMISSIONS, 'hooks.subscribe') === 'hooks');
    const asks = L.askLines(mod('hk', [v('worker', 'worker', 'W')], { state: 'off', permissions: ['hooks'] }));
    check('hooks: the card says what the permission does, plainly', asks.some((l) => l.strong && /React to the agent's actions before and after they happen, and block them/.test(l.text) && /file contents/.test(l.text)), asks);
  }

  done();
})().catch((err) => {
  console.log(`FAIL crashed | ${err && err.stack}`);
  process.exit(1);
});
