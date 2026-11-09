// The mod kit without a browser: loads modkit/harness.js in a node:vm context with a fake window and parent and
// checks the wire behaviour (hello, queued calls, param mapping, errors, subscriptions, model deltas, timeouts,
// sizing, error reports), then validates every bundled mod.json and checks that each mod page only calls what its
// manifest asks for. Needs no build. Run: node test/modkit.js
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert');
const { check, done } = require('./support/check.js');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'modkit/harness.js'), 'utf8');
const { validateManifest } = require(path.join(ROOT, 'modkit/playground/validate.js'));
const { listMods } = require(path.join(ROOT, 'modkit/playground/serve.js'));
const { PlaygroundHost } = require(path.join(ROOT, 'modkit/playground/host.js'));

const flush = () => new Promise((r) => setImmediate(r));
const same = (a, b) => { try { assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b); return true; } catch { return false; } };

/** A fresh page with harness.js loaded. `opts.noParent`: loaded outside a host. */
function page(opts = {}) {
  const sent = [];
  const listeners = {};
  const timers = [];
  const rafs = [];
  const observers = [];
  const warnings = [];
  const docListeners = {};
  const attrs = {};
  const style = {};
  const size = { height: 100 };
  const parent = { postMessage: (msg) => sent.push(JSON.parse(JSON.stringify(msg))) };
  const win = {
    document: {
      readyState: 'complete',
      addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
      documentElement: {
        setAttribute: (k, v) => { attrs[k] = v; },
        style: { setProperty: (k, v) => { style[k] = v; }, removeProperty: (k) => { delete style[k]; } },
        getBoundingClientRect: () => ({ height: size.height }),
      },
    },
    console: { warn: (...a) => warnings.push(a.join(' ')), log() {}, error() {} },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, id: timers.length + 1 }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    requestAnimationFrame: (fn) => { rafs.push(fn); return rafs.length; },
    ResizeObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
  };
  win.window = win;
  win.parent = opts.noParent ? win : parent;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'harness.js' });
  const p = {
    win, h: win.harness, sent, listeners, docListeners, timers, rafs, observers, warnings, attrs, style, size,
    click: (target) => { const ev = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (docListeners.click || []).forEach((fn) => fn(ev)); return ev; },
    deliver: (data, source = parent) => (listeners.message || []).forEach((fn) => fn({ source, data })),
    reply: (id, result) => p.deliver({ jsonrpc: '2.0', id, result }),
    fail: (id, error) => p.deliver({ jsonrpc: '2.0', id, error }),
    event: (name, data) => p.deliver({ jsonrpc: '2.0', method: 'event', params: { name, data } }),
    last: () => sent[sent.length - 1],
    runRafs: () => { const list = rafs.splice(0); list.forEach((f) => f()); },
  };
  return p;
}

const HELLO = {
  protocol: 1,
  mod: { id: 'demo', name: 'Demo', version: '1.0.0', scope: 'user' },
  view: { id: 'main', seat: 'rail', title: 'Demo' },
  app: { name: 'Open Harness', version: '0.1.0' },
  granted: ['session:read'],
  theme: { scheme: 'dark', tokens: { '--bg-100': '#262624', '--text-100': '#faf9f5', color: 'red' } },
  settings: { unit: 'words' },
  visible: true,
};

/** A page whose hello was answered. */
async function readyPage(hello = HELLO) {
  const p = page();
  p.reply(1, hello);
  await flush();
  return p;
}

(async () => {
  // --- hello and queued calls ---------------------------------------------------
  {
    const p = page();
    check('hello is the first message', p.sent.length === 1 && same(p.sent[0], { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: 1 } }), p.sent);
    check('harness.info is null before ready', p.h.info === null);
    check('protocol is 1', p.h.protocol === 1);
    let tasks;
    p.h.session.tasks().then((r) => { tasks = r; });
    await flush();
    check('a call made before ready waits for the hello answer', p.sent.length === 1);
    let ready;
    p.h.ready.then((r) => { ready = r; });
    p.reply(1, HELLO);
    await flush();
    check('ready resolves with the hello result', ready && ready.mod.id === 'demo');
    check('harness.info holds the hello result', p.h.info && p.h.info.view.seat === 'rail' && p.h.info.settings.unit === 'words');
    const methods = p.sent.slice(1).map((m) => m.method);
    check('after ready: the theme subscription, then the queued call', same(methods.slice(0, 2), ['events.subscribe', 'session.tasks']), methods);
    check('theme.changed is subscribed for the page', same(p.sent[1].params, { events: ['theme.changed'] }));
    check('a call without params sends none', !('params' in p.sent[2]), p.sent[2]);
    p.reply(p.sent[2].id, { tasks: [{ id: 't', title: 'x', status: 'pending' }] });
    await flush();
    check('the queued call resolves with the result', tasks && tasks.tasks.length === 1);
    check('theme: data-theme set from hello', p.attrs['data-theme'] === 'dark');
    check('theme: tokens applied as custom properties', p.style['--bg-100'] === '#262624' && p.style['--text-100'] === '#faf9f5');
    check('theme: non-token keys are ignored', !('color' in p.style));
    p.event('theme.changed', { scheme: 'light', tokens: { '--bg-100': '#faf9f5' } });
    check('theme.changed switches data-theme', p.attrs['data-theme'] === 'light');
    check('theme.changed applies new tokens and drops ones no longer sent', p.style['--bg-100'] === '#faf9f5' && !('--text-100' in p.style));
    const before = p.sent.length;
    p.deliver({ jsonrpc: '2.0', method: 'event', params: { name: 'theme.changed', data: { scheme: 'dark', tokens: {} } } }, { postMessage() {} });
    check('messages from another window are ignored', p.attrs['data-theme'] === 'light' && p.sent.length === before);
    p.deliver({ jsonrpc: '2.0', id: 999, result: 1 });
    p.deliver('not json-rpc');
    check('unknown ids and foreign messages do not throw', true);
  }

  // --- param mapping, one or more per namespace -------------------------------------
  {
    const p = await readyPage();
    const cases = [
      ['ui.setBadge(v)', () => p.h.ui.setBadge(3), 'ui.setBadge', { badge: 3 }, null],
      ['ui.setBadge() clears', () => p.h.ui.setBadge(), 'ui.setBadge', { badge: null }, null],
      ['ui.setTitle', () => p.h.ui.setTitle('T'), 'ui.setTitle', { title: 'T' }, null],
      ['ui.toast(text, {kind})', () => p.h.ui.toast('hi', { kind: 'error' }), 'ui.toast', { text: 'hi', kind: 'error' }, null],
      ['ui.toast(text) leaves kind out', () => p.h.ui.toast('hi'), 'ui.toast', { text: 'hi' }, null],
      ['ui.open(viewId)', () => p.h.ui.open('side'), 'ui.open', { view: 'side' }, null],
      ['ui.copy', () => p.h.ui.copy('x'), 'ui.copy', { text: 'x' }, true, true],
      ['ui.openExternal', () => p.h.ui.openExternal('https://a.b'), 'ui.openExternal', { url: 'https://a.b' }, null],
      ['ui.openPage', () => p.h.ui.openPage('scheduled', { form: 'new' }), 'ui.openPage', { page: 'scheduled', form: 'new' }, null],
      ['ui.markdown', () => p.h.ui.markdown('# h'), 'ui.markdown', { text: '# h' }, { html: '<h1>h</h1>' }, { html: '<h1>h</h1>' }],
      ['ui.resize(h)', () => p.h.ui.resize(42.2), 'ui.resize', { height: 43 }, null],
      ['storage.get(key, fallback) → fallback when undefined', () => p.h.storage.get('k', 5), 'storage.get', { key: 'k' }, {}, 5],
      ['storage.get returns the value', () => p.h.storage.get('k', 5), 'storage.get', { key: 'k' }, { value: { a: 1 } }, { a: 1 }],
      ['storage.get keeps a stored null', () => p.h.storage.get('k', 5), 'storage.get', { key: 'k' }, { value: null }, null],
      ['storage.set', () => p.h.storage.set('k', [1]), 'storage.set', { key: 'k', value: [1] }, null],
      ['storage.keys → array', () => p.h.storage.keys(), 'storage.keys', {}, { keys: ['a'] }, ['a']],
      ['storage.session.set → scope session', () => p.h.storage.session.set('k', 1), 'storage.set', { key: 'k', value: 1, scope: 'session' }, null],
      ['storage.session.remove', () => p.h.storage.session.remove('k'), 'storage.remove', { key: 'k', scope: 'session' }, null],
      ['storage.session.keys', () => p.h.storage.session.keys(), 'storage.keys', { scope: 'session' }, { keys: [] }, []],
      ['settings.get', () => p.h.settings.get(), 'settings.get', undefined, { unit: 'words' }],
      ['session.transcript({limit})', () => p.h.session.transcript({ limit: 5 }), 'session.transcript', { limit: 5 }, { items: [] }],
      ['session.transcript() sends no limit', () => p.h.session.transcript(), 'session.transcript', {}, { items: [] }],
      ['session.compact(focus)', () => p.h.session.compact('tests'), 'session.compact', { focus: 'tests' }, { ok: true }],
      ['session.send', () => p.h.session.send('go'), 'session.send', { text: 'go' }, { ok: true }],
      ['outputs.open({kind, id})', () => p.h.outputs.open({ kind: 'file', id: 'a.ts' }), 'outputs.open', { kind: 'file', id: 'a.ts' }, null],
      ['composer.insert', () => p.h.composer.insert('x'), 'composer.insert', { text: 'x' }, null],
      ['sessions.search(query, {limit})', () => p.h.sessions.search('mod', { limit: 3 }), 'sessions.search', { query: 'mod', limit: 3 }, { hits: [] }],
      ['sessions.open(id)', () => p.h.sessions.open('s1'), 'sessions.open', { id: 's1' }, null],
      ['sessions.spawn({title, prompt})', () => p.h.sessions.spawn({ title: 'T', prompt: 'P' }), 'sessions.spawn', { title: 'T', prompt: 'P' }, {}],
      ['sessions.merge(id)', () => p.h.sessions.merge('s2'), 'sessions.merge', { id: 's2' }, { ok: true }],
      ['skills.list → the array', () => p.h.skills.list(), 'skills.list', undefined, { skills: [{ name: 'a' }] }, [{ name: 'a' }]],
      ['skills.usage({scope})', () => p.h.skills.usage({ scope: 'all' }), 'skills.usage', { scope: 'all' }, { items: [] }],
      ['config.get', () => p.h.config.get(), 'config.get', undefined, {}],
      ['config.set(patch) → {patch}', () => p.h.config.set({ keepAwake: 'always' }), 'config.set', { patch: { keepAwake: 'always' } }, {}],
      ['schedules.create(input) → {input}', () => p.h.schedules.create({ name: 'n' }), 'schedules.create', { input: { name: 'n' } }, {}],
      ['schedules.update(id, patch)', () => p.h.schedules.update('s1', { enabled: false }), 'schedules.update', { id: 's1', patch: { enabled: false } }, {}],
      ['schedules.remove(id)', () => p.h.schedules.remove('s1'), 'schedules.remove', { id: 's1' }, null],
      ['schedules.runNow(id)', () => p.h.schedules.runNow('s1'), 'schedules.runNow', { id: 's1' }, null],
      ['remote.start', () => p.h.remote.start(), 'remote.start', undefined, { enabled: true }],
      ['raw call', () => p.h.call('session.get'), 'session.get', undefined, { id: 's' }],
    ];
    for (const [label, fn, method, params, result, expected] of cases) {
      let got = 'pending';
      fn().then((r) => { got = r; }, (e) => { got = e; });
      await flush();
      const m = p.last();
      const okParams = params === undefined ? !('params' in m) : same(m.params, params);
      p.reply(m.id, result);
      await flush();
      const want = expected === undefined ? result : expected;
      check(`params: ${label}`, m.method === method && okParams && same(got, want), { sent: m, got });
    }
  }

  // --- errors -------------------------------------------------------------------------
  {
    const p = await readyPage();
    const codes = [
      [{ code: 4003, message: 'needs session:read', data: { permission: 'session:read' } }, 'permission'],
      [{ code: -32601, message: 'no' }, 'unknown-method'],
      [{ code: -32602, message: 'bad' }, 'bad-params'],
      [{ code: 4004, message: 'later' }, 'unavailable'],
      [{ code: 4008, message: 'slow' }, 'timeout'],
      [{ code: 4000, message: 'oops' }, 'error'],
      [{ code: 1234, message: 'odd' }, 'error'],
    ];
    for (const [error, code] of codes) {
      let err;
      p.h.session.get().catch((e) => { err = e; });
      await flush();
      p.fail(p.last().id, error);
      await flush();
      check(`error ${error.code} → code '${code}'`, err && err.code === code && err.message === error.message && err.rpcCode === error.code, err && { code: err.code, message: err.message });
      if (code === 'permission') check('a permission error names the permission', err.permission === 'session:read' && err.data.permission === 'session:read');
      check(`error ${error.code} is an Error`, err && typeof err.stack === 'string' && err.method === 'session.get');
    }
  }

  // --- subscriptions ---------------------------------------------------------------------
  {
    const p = await readyPage();
    const subs = () => p.sent.filter((m) => m.method === 'events.subscribe' && m.params.events[0] === 'tasks.changed').length;
    const unsubs = () => p.sent.filter((m) => m.method === 'events.unsubscribe' && m.params.events[0] === 'tasks.changed').length;
    const got = [];
    const offA = p.h.on('tasks.changed', (d) => got.push(['a', d.n]));
    const offB = p.h.on('tasks.changed', (d) => got.push(['b', d.n]));
    await flush();
    check('the first handler subscribes, the second does not', subs() === 1, p.sent.map((m) => m.method));
    p.event('tasks.changed', { n: 1 });
    check('an event reaches every handler, in order', same(got, [['a', 1], ['b', 1]]));
    offA();
    offA();
    await flush();
    check('removing one of two handlers does not unsubscribe (and off is idempotent)', unsubs() === 0);
    p.event('tasks.changed', { n: 2 });
    check('the remaining handler still gets events', same(got.slice(2), [['b', 2]]));
    offB();
    await flush();
    check('removing the last handler unsubscribes once', unsubs() === 1 && same(p.last().params, { events: ['tasks.changed'] }));
    p.event('tasks.changed', { n: 3 });
    check('no handler runs after unsubscribing', got.length === 3);
    p.h.on('tasks.changed', () => {});
    await flush();
    check('subscribing again sends a new subscribe', subs() === 2);
    // A handler that throws is reported, the others still run
    let ran = false;
    p.h.on('plan.changed', () => { throw new Error('handler broke'); });
    p.h.on('plan.changed', () => { ran = true; });
    await flush();
    p.event('plan.changed', { plan: null });
    await flush();
    const report = p.sent.filter((m) => m.method === 'log.error').pop();
    check('a throwing handler is reported with log.error', report && report.params.message === 'handler broke' && /handler broke/.test(report.params.stack));
    check('the next handler still runs', ran);
    let threw = false;
    try { p.h.on('x'); } catch (e) { threw = true; }
    check('on() without a handler throws a TypeError', threw);
    // A refused subscription warns instead of rejecting into the page
    p.h.on('remote.changed', () => {});
    await flush();
    p.fail(p.last().id, { code: 4003, message: 'needs remote', data: { permission: 'remote' } });
    await flush();
    check('a refused subscription becomes a console warning', p.warnings.some((w) => /remote\.changed/.test(w)), p.warnings);
  }

  // --- model.complete: deltas and cancel ----------------------------------------------------
  {
    const p = await readyPage();
    const timersBefore = p.timers.length;
    const deltas = [];
    let result;
    const call = p.h.model.complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }, (t) => deltas.push(t));
    call.then((r) => { result = r; });
    await flush();
    const sub = p.sent[p.sent.length - 2];
    const req = p.last();
    check('model.complete subscribes to model.delta first', sub.method === 'events.subscribe' && same(sub.params, { events: ['model.delta'] }));
    check('model.complete sends the request with a requestId', req.method === 'model.complete' && typeof req.params.requestId === 'string' && req.params.requestId.length > 3 && req.params.maxTokens === 50);
    const rid = req.params.requestId;
    const reqTimers = p.timers.slice(timersBefore).filter((t) => t.ms === 30000 && !t.cleared);
    check('model.complete has no 30 s timeout', reqTimers.length === 1, reqTimers.length);
    p.event('model.delta', { requestId: rid, text: 'Hel' });
    p.event('model.delta', { requestId: 'someone-else', text: 'XX' });
    p.event('model.delta', { requestId: rid, text: 'lo' });
    check('deltas with its requestId reach onDelta, others do not', same(deltas, ['Hel', 'lo']));
    // a second call in parallel keeps its own deltas
    const deltas2 = [];
    const call2 = p.h.model.complete({ messages: [{ role: 'user', content: 'b' }], requestId: 'mine' }, (t) => deltas2.push(t));
    call2.catch(() => {});
    await flush();
    check('a caller-chosen requestId is kept', p.last().params.requestId === 'mine');
    p.event('model.delta', { requestId: 'mine', text: 'B' });
    check('parallel calls route their own deltas', same(deltas2, ['B']) && same(deltas, ['Hel', 'lo']));
    p.h.model.cancel();
    await flush();
    const cancels = p.sent.filter((m) => m.method === 'model.cancel').map((m) => m.params.requestId).sort();
    check('cancel() cancels the calls in progress by requestId', same(cancels, [rid, 'mine'].sort()), cancels);
    p.reply(req.id, { text: 'Hello', usage: { promptTokens: 1, completionTokens: 2 } });
    await flush();
    check('model.complete resolves with the result', result && result.text === 'Hello');
    check('model.delta stays subscribed while another call runs', !p.sent.some((m) => m.method === 'events.unsubscribe' && m.params.events[0] === 'model.delta'));
    p.fail(p.sent.find((m) => m.method === 'model.complete' && m.params.requestId === 'mine').id, { code: 4000, message: 'Cancelled' });
    await flush();
    check('model.delta is unsubscribed when the last call ends', p.sent.some((m) => m.method === 'events.unsubscribe' && m.params.events[0] === 'model.delta'));
    p.event('model.delta', { requestId: rid, text: 'late' });
    check('no deltas after the call ended', same(deltas, ['Hel', 'lo']));
    const n = p.sent.length;
    await p.h.model.cancel();
    check('cancel() with nothing running sends nothing', p.sent.length === n);
  }

  // --- timeouts ------------------------------------------------------------------------------
  {
    const p = await readyPage();
    let err;
    p.h.ui.theme().catch((e) => { err = e; });
    await flush();
    const id = p.last().id;
    const timer = p.timers.filter((t) => t.ms === 30000 && !t.cleared).pop();
    check('a request arms a 30 s timer', !!timer);
    timer.fn();
    await flush();
    check('a request with no answer rejects with code timeout', err && err.code === 'timeout' && err.method === 'ui.theme', err && err.message);
    p.reply(id, { scheme: 'light' });
    check('a late answer is ignored', true);
    let ok;
    p.h.ui.theme().then((r) => { ok = r; });
    await flush();
    const t2 = p.timers[p.timers.length - 1];
    p.reply(p.last().id, { scheme: 'dark', tokens: {} });
    await flush();
    check('an answer clears its timer', t2.cleared === true && ok.scheme === 'dark');
    check('hello itself has no timeout', page().timers.length === 0);
  }

  // --- size reports (rail and composer) ---------------------------------------------------------
  {
    const p = await readyPage();
    const resizes = () => p.sent.filter((m) => m.method === 'ui.resize');
    check('a rail view observes its size', p.observers.length === 1);
    p.size.height = 120.4;
    p.runRafs();
    await flush();
    check('the first frame reports the height (rounded up)', resizes().length === 1 && resizes()[0].params.height === 121, resizes());
    p.observers[0]();
    p.observers[0]();
    check('several changes in one frame are one report', p.rafs.length === 1);
    p.runRafs();
    await flush();
    check('an unchanged height is not reported again', resizes().length === 1);
    p.size.height = 200;
    p.observers[0]();
    p.runRafs();
    await flush();
    check('a new height is reported', resizes().length === 2 && resizes()[1].params.height === 200);
    p.h.ui.resize();
    await flush();
    check('ui.resize() forces a report', resizes().length === 3 && resizes()[2].params.height === 200);
    const tab = await readyPage(Object.assign({}, HELLO, { view: { id: 'main', seat: 'tab', title: 'T' } }));
    check('a tab view does not report its size', tab.observers.length === 0 && tab.rafs.length === 0);
    const comp = await readyPage(Object.assign({}, HELLO, { view: { id: 'main', seat: 'composer', title: 'C' } }));
    check('a composer view reports its size', comp.observers.length === 1);
  }

  // --- page errors -------------------------------------------------------------------------------
  {
    const p = await readyPage();
    const e = new Error('kaput');
    p.listeners.error.forEach((fn) => fn({ error: e, message: 'Uncaught Error: kaput' }));
    await flush();
    let r = p.sent.filter((m) => m.method === 'log.error').pop();
    check('window errors are reported with log.error', r && r.params.message === 'kaput' && /kaput/.test(r.params.stack));
    p.listeners.error.forEach((fn) => fn({ error: null, message: 'Script error.', filename: 'x.js', lineno: 3 }));
    await flush();
    r = p.sent.filter((m) => m.method === 'log.error').pop();
    check('an error without an Error object still reports its message', r && /Script error\. \(x\.js:3\)/.test(r.params.message), r && r.params);
    p.listeners.unhandledrejection.forEach((fn) => fn({ reason: new Error('nope') }));
    p.listeners.unhandledrejection.forEach((fn) => fn({ reason: 'plain' }));
    await flush();
    const rs = p.sent.filter((m) => m.method === 'log.error').slice(-2).map((m) => m.params.message);
    check('unhandled rejections are reported', rs[0] === 'nope' && /plain/.test(rs[1]), rs);
  }

  // --- outside a host ----------------------------------------------------------------------------------
  {
    let p;
    let threw = false;
    try { p = page({ noParent: true }); } catch (e) { threw = e; }
    check('loading without a parent does not throw', !threw, threw && threw.message);
    check('harness exists without a parent', p && typeof p.h.session.get === 'function');
    check('a console warning explains it', p.warnings.some((w) => /not inside Silo Harness/.test(w)));
    check('nothing is posted and no listener is added', p.sent.length === 0 && !p.listeners.message);
    let settled = false;
    p.h.ready.then(() => { settled = true; });
    p.h.session.get().then(() => { settled = true; }, () => { settled = true; });
    await flush();
    check('ready and calls stay pending', !settled);
    let ok = true;
    try { p.h.on('tasks.changed', () => {})(); } catch (e) { ok = false; }
    check('on() and its unsubscribe work without a host', ok);
  }

  // --- .h-md: Copy buttons and links in rendered Markdown ---------------------------------------------------
  {
    // A tiny element tree: enough of closest/querySelector/classList for harness.js's click handler
    const node = (tag, cls = '', attrs = {}, kids = []) => {
      const n = { nodeType: 1, tag, cls: new Set(cls.split(' ').filter(Boolean)), attrs, parent: null, kids, text: '' };
      kids.forEach((k) => { k.parent = n; });
      const matches = (x, sel) => sel.split(',').some((one) => {
        one = one.trim();
        if (one.startsWith('.')) return x.cls.has(one.slice(1));
        const m = /^(\w+)(\[(\w+)\])?$/.exec(one);
        return m && x.tag === m[1] && (!m[3] || m[3] in x.attrs);
      });
      const all = (x) => x.kids.flatMap((k) => [k, ...all(k)]);
      n.closest = (sel) => { for (let x = n; x; x = x.parent) if (matches(x, sel)) return x; return null; };
      n.querySelector = (sel) => {
        const parts = sel.split(' ');
        if (parts.length === 2) { for (const a of all(n)) if (matches(a, parts[0])) { const b = all(a).find((k) => matches(k, parts[1])); if (b) return b; } return null; }
        return all(n).find((k) => matches(k, sel)) || null;
      };
      n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null);
      n.classList = { add: (c) => n.cls.add(c), remove: (c) => n.cls.delete(c), contains: (c) => n.cls.has(c) };
      Object.defineProperty(n, 'textContent', { get: () => n.text + n.kids.map((k) => k.textContent).join(''), set: (v) => { n.text = v; n.kids = []; } });
      return n;
    };
    const tree = () => {
      const label = node('span');
      label.text = 'Copy';
      const btn = node('button', 'code-copy', {}, [node('svg'), label]);
      const code = node('code');
      code.text = 'npm test';
      const block = node('div', 'code-block', {}, [node('div', 'code-head', {}, [node('span', 'code-lang'), btn]), node('pre', '', {}, [code])]);
      const link = node('a', '', { href: 'https://example.com/x' });
      link.href = 'https://example.com/x';
      const hash = node('a', '', { href: '#part' });
      hash.href = 'mod://demo.user/panel.html#part';
      const rel = node('a', '', { href: 'notes.html' });
      rel.href = 'mod://demo.user/notes.html';
      const md = node('div', 'h-md', {}, [block, node('p', '', {}, [link, hash, rel])]);
      const outsideBtn = node('button', 'code-copy');
      const outsideLink = node('a', '', { href: 'https://example.com/out' });
      outsideLink.href = 'https://example.com/out';
      node('body', '', {}, [md, node('div', 'other', {}, [outsideBtn, outsideLink])]);
      return { btn, label, link, hash, rel, outsideBtn, outsideLink };
    };
    const p = await readyPage();
    const t = tree();
    check('h-md: the kit listens for clicks on the page', (p.docListeners.click || []).length === 1);
    const ev = p.click(t.label);
    await flush();
    const copy = p.last();
    check('h-md: Copy in a code block copies that block\'s code with ui.copy', copy.method === 'ui.copy' && copy.params.text === 'npm test' && ev.defaultPrevented, copy);
    p.reply(copy.id, null);
    await flush();
    check('h-md: the button flips to "Copied"', t.btn.classList.contains('copied') && t.label.textContent === 'Copied');
    const flip = p.timers.filter((x) => x.ms === 1500 && !x.cleared).pop();
    check('h-md: and back after a moment', !!flip);
    flip.fn();
    check('h-md: label and class restored', !t.btn.classList.contains('copied') && t.label.textContent === 'Copy');
    const n0 = p.sent.length;
    const ev2 = p.click(t.link);
    await flush();
    const open = p.last();
    check('h-md: a link opens with ui.openExternal and does not navigate the frame', p.sent.length === n0 + 1 && open.method === 'ui.openExternal' && open.params.url === 'https://example.com/x' && ev2.defaultPrevented, open);
    const n1 = p.sent.length;
    const ev3 = p.click(t.hash);
    const ev4 = p.click(t.rel);
    await flush();
    check('h-md: a #fragment link is left to the page', !ev3.defaultPrevented);
    check('h-md: a link that is not http(s) is stopped and not opened', ev4.defaultPrevented && p.sent.length === n1);
    const ev5 = p.click(t.outsideBtn);
    const ev6 = p.click(t.outsideLink);
    await flush();
    check('h-md: clicks outside .h-md are left alone', !ev5.defaultPrevented && !ev6.defaultPrevented && p.sent.length === n1);
    // A failed copy says so
    const t2 = tree();
    p.click(t2.btn);
    await flush();
    p.fail(p.last().id, { code: 4000, message: 'clipboard busy' });
    await flush();
    await flush();
    const toast = p.last();
    check('h-md: a failed copy shows a toast and does not flip', toast.method === 'ui.toast' && toast.params.kind === 'error' && /clipboard busy/.test(toast.params.text) && !t2.btn.classList.contains('copied'), toast);
  }

  // --- hooks: harness.hooks.on registers, the host asks, the page answers ------------------------------------
  {
    const p = await readyPage(Object.assign({}, HELLO, { view: { id: 'w', seat: 'worker', title: 'W' }, granted: ['hooks'] }));
    const seen = [];
    p.h.hooks.on('PreToolUse', (input) => { seen.push(input); return input.tool_name === 'Read' ? { hookSpecificOutput: { permissionDecision: 'ask' } } : undefined; });
    await flush();
    const sub = p.sent.find((m) => m.method === 'hooks.subscribe');
    check('hooks.on: registers the event with the host', sub && same(sub.params, { events: ['PreToolUse'] }), sub);
    p.reply(sub.id, null);
    p.deliver({ jsonrpc: '2.0', id: 'hook-1', method: 'hook', params: { event: 'PreToolUse', input: { tool_name: 'Read', tool_input: { file_path: '/a' } } } });
    await flush();
    const r1 = p.sent.find((m) => m.id === 'hook-1');
    check('hook request: the handler gets the input and its output object is the result', seen[0]?.tool_input?.file_path === '/a' && r1 && same(r1, { jsonrpc: '2.0', id: 'hook-1', result: { hookSpecificOutput: { permissionDecision: 'ask' } } }), r1);
    p.deliver({ jsonrpc: '2.0', id: 'hook-2', method: 'hook', params: { event: 'PreToolUse', input: { tool_name: 'Bash' } } });
    await flush();
    check('hook request: nothing returned is a null result', same(p.sent.find((m) => m.id === 'hook-2'), { jsonrpc: '2.0', id: 'hook-2', result: null }));
    p.deliver({ jsonrpc: '2.0', id: 'hook-3', method: 'hook', params: { event: 'Stop', input: {} } });
    await flush();
    check('hook request for an event without a handler: null', same(p.sent.find((m) => m.id === 'hook-3'), { jsonrpc: '2.0', id: 'hook-3', result: null }));
    p.h.hooks.on('Stop', async () => { throw new Error('broken handler'); });
    p.deliver({ jsonrpc: '2.0', id: 'hook-4', method: 'hook', params: { event: 'Stop', input: {} } });
    await flush();
    await flush();
    const r4 = p.sent.find((m) => m.id === 'hook-4');
    check('hook request: a handler that throws answers with an error', r4 && r4.error && /broken handler/.test(r4.error.message), r4);
    p.h.hooks.on('UserPromptSubmit', () => Promise.resolve(['not', 'an', 'object']));
    p.deliver({ jsonrpc: '2.0', id: 'hook-5', method: 'hook', params: { event: 'UserPromptSubmit', input: {} } });
    await flush();
    await flush();
    check('hook request: a value that is not an object decides nothing', same(p.sent.find((m) => m.id === 'hook-5'), { jsonrpc: '2.0', id: 'hook-5', result: null }));
    p.h.hooks.off('PreToolUse');
    await flush();
    const unsub = p.sent.find((m) => m.method === 'hooks.unsubscribe');
    check('hooks.off: unregisters', unsub && same(unsub.params, { events: ['PreToolUse'] }));
    // A page from a frame that is not the host is ignored
    p.deliver({ jsonrpc: '2.0', id: 'hook-x', method: 'hook', params: { event: 'Stop', input: {} } }, {});
    await flush();
    check('hook request from another frame: ignored', !p.sent.some((m) => m.id === 'hook-x'));
  }

  // --- harness.css: the Markdown class and its tokens ------------------------------------------------------
  {
    const css = fs.readFileSync(path.join(ROOT, 'modkit/harness.css'), 'utf8');
    const blocks = [css.slice(0, css.indexOf('@media')), css.slice(css.indexOf('@media'), css.indexOf(':root[data-theme="dark"]')), css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('/* ---------- Page'))];
    for (const tok of ['--code-bg', '--code-hover', '--bubble', '--tok-kw', '--tok-str', '--tok-com', '--tok-num', '--tok-pun']) check(`harness.css: ${tok} has a default`, blocks[0].includes(tok + ':'));
    for (const tok of ['--code-bg', '--bubble', '--tok-kw', '--tok-num']) check(`harness.css: ${tok} has a dark value in both dark blocks`, blocks[1].includes(tok + ':') && blocks[2].includes(tok + ':'));
    for (const sel of ['.h-md p', '.h-md h1', '.h-md ul', '.h-md a', '.h-md code', '.h-md blockquote', '.h-md table', '.h-md .code-block', '.h-md .code-head', '.h-md .code-copy', '.h-md .code-copy.copied', '.h-md .tok-kw', '.h-md li.task', '.h-md.compact']) check(`harness.css: styles ${sel}`, css.includes(sel));
    // The Markdown the kit styles is the app's: every class markdown.ts emits has a rule
    const mdSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/markdown.ts'), 'utf8');
    const emitted = [...new Set([...mdSrc.matchAll(/class="([a-z-]+)/g)].map((m) => m[1]).filter((c) => c !== 'icon'))];
    const missing = emitted.filter((c) => !new RegExp(`\\.h-md[^{]*\\.${c}\\b`).test(css) && !new RegExp(`\\.h-md [a-z]+\\.${c}\\b`).test(css));
    check('harness.css: every class the Markdown renderer emits is styled under .h-md', missing.length === 0, missing);
    for (const folder of ['side-chat', 'plan']) {
      const html = fs.readFileSync(path.join(ROOT, 'mods', folder, 'panel.html'), 'utf8');
      check(`${folder}: renders Markdown in .h-md and keeps no copy of the app's .md rules`, /h-md/.test(html) && !/\.md (code|pre|h1|ul|blockquote|\.code-block)/.test(html) && !/\.tok-kw\s*\{/.test(html));
      check(`${folder}: no hand-made link or Copy handler (the kit does it)`, !/closest\('\.code-copy'\)/.test(html) && !/querySelectorAll\('a\[href\]'\)/.test(html));
    }
  }

  // --- the playground host: the protocol as it now stands -------------------------------------------------
  {
    const hostModule = require(path.join(ROOT, 'modkit/playground/host.js'));
    const Fixture = require(path.join(ROOT, 'modkit/playground/fixture.js'));
    hostModule.PlaygroundFixture = Fixture; // host.js reaches the fixture through its root, as in the page
    const mkHost = (state = 'full') => {
      const host = new PlaygroundHost({ world: Fixture.build(state), ui: { theme: () => ({ scheme: 'light', tokens: {} }) } });
      const view = (id, permissions) => {
        const got = [];
        host.addMod({ protocol: 1, id, name: id, version: '1.0.0', permissions, contributes: { views: [{ id: 'main', title: id, entry: 'panel.html', seat: 'tab' }] } }, {});
        host.attach({ key: id + '/main', modId: id, view: { id: 'main', seat: 'tab', title: id }, win: { postMessage: (m) => got.push(JSON.parse(JSON.stringify(m))) } });
        const rec = host.views[host.views.length - 1];
        const events = (name) => got.filter((m) => m.method === 'event' && (!name || m.params.name === name)).map((m) => m.params.data);
        return { rec, got, events, call: (method, params = {}) => Promise.resolve().then(() => host.handle(rec, method, params)) };
      };
      return { host, view };
    };
    const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

    // model.complete resolves with the partial text and stopped: true after model.cancel
    {
      const { view } = mkHost();
      const v = view('chat', ['model', 'session:read']);
      await v.call('events.subscribe', { events: ['model.delta'] });
      const run = v.call('model.complete', { messages: [{ role: 'user', content: 'what does --no-verify do?' }], requestId: 'r1', context: 'session' });
      await new Promise((r) => setTimeout(r, 200));
      await v.call('model.cancel', { requestId: 'r1' });
      const r = await run;
      const streamed = v.events('model.delta').map((d) => d.text).join('');
      check('host: model.complete resolves after model.cancel with stopped: true', r && r.stopped === true && typeof r.text === 'string' && r.text.length > 0, r);
      check('host: the stopped result holds exactly what was streamed', r.text === streamed, { text: r.text, streamed });
      const full = await v.call('model.complete', { messages: [{ role: 'user', content: 'hi' }], requestId: 'r2' });
      check('host: an uncancelled reply has no stopped flag and carries usage', !full.stopped && full.usage && full.usage.completionTokens > 0, full);
      const bad = await refusal(() => v.call('model.complete', { messages: [{ role: 'system', content: 'x' }] }));
      check('host: model.complete refuses a message without a user/assistant role', bad && bad.code === -32602);
    }
    // model failures the playground can simulate
    {
      const { host, view } = mkHost();
      const v = view('chat', ['model']);
      host.world.model.mode = 'nokey';
      const e1 = await refusal(() => v.call('model.complete', { messages: [{ role: 'user', content: 'x' }] }));
      host.world.model.mode = 'unreachable';
      const e2 = await refusal(() => v.call('model.complete', { messages: [{ role: 'user', content: 'x' }] }));
      check('host: model mode nokey refuses with 4004, unreachable with 4000', e1 && e1.code === 4004 && e2 && e2.code === 4000, [e1, e2]);
    }
    // session.switched reaches every subscribed view, with no permission
    {
      const { host, view } = mkHost();
      const bare = view('bare', []);
      const reader = view('reader', ['session:read']);
      const quiet = view('quiet', ['session:read']);
      await bare.call('events.subscribe', { events: ['session.switched'] });
      await reader.call('events.subscribe', { events: ['session.switched', 'session.changed'] });
      host.switchTo('s-other');
      check('host: session.switched reaches a view without session:read', JSON.stringify(bare.events('session.switched')) === JSON.stringify([{ id: 's-other' }]), bare.events());
      check('host: session.switched and session.changed reach a session:read view', reader.events('session.switched').length === 1 && reader.events('session.changed').some((s) => s.id === 's-other'));
      check('host: a view that did not subscribe gets nothing', quiet.events().length === 0);
      host.switchTo('s-other');
      check('host: switching to the session already on screen sends no session.switched', bare.events('session.switched').length === 1);
    }
    // related.changed goes to session:read holders when a related session changes state
    {
      const { host, view } = mkHost('full');
      const reader = view('reader', ['session:read']);
      const bare = view('bare', []);
      await reader.call('events.subscribe', { events: ['related.changed'] });
      const refused = await refusal(() => bare.call('events.subscribe', { events: ['related.changed'] }));
      check('host: subscribing to an event without its permission is refused with 4003', refused && refused.code === 4003 && refused.data.permission === 'session:read', refused);
      host.setRelatedState('s-c2', { running: false });
      check('host: a sub-session finishing sends related.changed', reader.events('related.changed').length === 1);
      host.setRelatedState('s-other', { running: true });
      check('host: an unrelated session changing sends nothing', reader.events('related.changed').length === 1);
      const rel = await reader.call('session.related');
      check('host: session.related shows the new state', rel.children.find((c) => c.id === 's-c2').running === false);
    }
    // the context breakdown carries compactable
    {
      const { host, view } = mkHost('full');
      const v = view('ctx', ['session:read']);
      const c = await v.call('session.context');
      check('host: the context breakdown carries compactable', c.compactable === true, c.compactable);
      host.cur().session.running = true;
      check('host: compactable is false while a run is going', (await v.call('session.context')).compactable === false);
      host.switchTo('s-other');
      host.cur().context.messages = 2;
      check('host: compactable is false for a short conversation', (await v.call('session.context')).compactable === false);
    }
    // the public config: home, workingDirectory follows the session on screen, config.set refuses other keys
    {
      const { host, view } = mkHost('full');
      const v = view('env', ['config:read', 'config:write']);
      const c = await v.call('config.get');
      check('host: config.get carries home', c.home === host.world.home && typeof c.home === 'string');
      check('host: workingDirectory is the folder of the session on screen', c.workingDirectory === host.cur().session.cwd);
      host.world.sessions['s-other'].session.cwd = '/tmp/elsewhere';
      host.switchTo('s-other');
      check('host: workingDirectory follows a switch', (await v.call('config.get')).workingDirectory === '/tmp/elsewhere');
      const e = await refusal(() => v.call('config.set', { patch: { permissionMode: 'bypass' } }));
      check('host: config.set with another key is refused as bad params', e && e.code === -32602, e);
      const ok = await v.call('config.set', { patch: { keepAwake: 'always' } });
      check('host: config.set of a writable key answers with the public config', ok.keepAwake === 'always' && ok.home === host.world.home);
    }
    // schedules: validation, the calls and the event
    {
      const { host, view } = mkHost('empty');
      const v = view('sched', ['schedules', 'session:control']);
      await v.call('events.subscribe', { events: ['schedules.changed'] });
      const at = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
      const refusedWith = async (input, re, label) => {
        const e = await refusal(() => v.call('schedules.create', { input }));
        check('host: schedules.create refuses ' + label, e && e.code === -32602 && re.test(e.message), e && e.message);
      };
      await refusedWith({ name: 'x', prompt: 'p', when: { kind: 'at', at: new Date(Date.now() - 60000).toISOString() } }, /passed/, 'a past time');
      await refusedWith({ name: 'x', prompt: 'p', when: { kind: 'every', minutes: 4 } }, /5 minutes/, 'under five minutes');
      await refusedWith({ name: 'x', prompt: '  ', when: { kind: 'every', minutes: 30 } }, /prompt/, 'an empty prompt');
      await refusedWith({ name: 'x', prompt: 'p', when: { kind: 'cron', expr: '0 25 * * *' } }, /hour/, 'a cron field out of range');
      await refusedWith({ name: 'x', prompt: 'p', when: { kind: 'cron', expr: '0 9 * *' } }, /five fields/, 'a cron expression without five fields');
      const a = await v.call('schedules.create', { input: { name: 'Once', prompt: 'p', when: { kind: 'at', at } } });
      const b = await v.call('schedules.create', { input: { name: 'Rhythm', prompt: 'p', when: { kind: 'every', minutes: 90 }, target: 'session' } });
      const c = await v.call('schedules.create', { input: { name: 'Cron', prompt: 'p', when: { kind: 'cron', expr: '0 9 * * 1-5' } } });
      check('host: created schedules have a next run and a description', a.nextRunAt === Date.parse(at) && /^once on /.test(a.describe) && b.describe === 'every 90 minutes' && c.describe === 'weekdays at 09:00' && c.nextRunAt > Date.now(), [a.describe, b.describe, c.describe]);
      check('host: "This session" without an id is the session on screen', b.target === 'session' && b.sessionId === host.cur().session.id);
      check('host: each create sends schedules.changed with the list', v.events('schedules.changed').length === 3 && v.events('schedules.changed')[2].schedules.length === 3);
      const off = await v.call('schedules.update', { id: b.id, patch: { enabled: false } });
      check('host: turning one off clears its next run', off.enabled === false && off.nextRunAt === null);
      const ed = await v.call('schedules.update', { id: b.id, patch: { name: 'Every two hours', when: { kind: 'every', minutes: 120 }, enabled: true, target: 'new' } });
      check('host: an edit changes the rhythm, the description and the target', ed.describe === 'every 2 hours' && ed.nextRunAt > Date.now() && ed.target === 'new' && !ed.sessionId, ed);
      const e = await refusal(() => v.call('schedules.update', { id: b.id, patch: { cwd: '/' } }));
      check('host: schedules.update refuses a field it cannot change', e && e.code === -32602);
      await v.call('schedules.runNow', { id: c.id });
      const ran = host.world.schedules.find((x) => x.id === c.id);
      check('host: runNow marks it running with a session for the run', ran.lastStatus === 'running' && ran.runs === 1 && !!host.world.sessions[ran.lastSessionId]);
      const again = await refusal(() => v.call('schedules.runNow', { id: c.id }));
      check('host: runNow refuses while it is running', again && again.code === 4000 && /already running/.test(again.message));
      await v.call('schedules.remove', { id: a.id });
      check('host: remove takes it out of the list and says so', !host.world.schedules.some((x) => x.id === a.id) && v.events('schedules.changed').pop().schedules.length === 2);
      const gone = await refusal(() => v.call('schedules.remove', { id: a.id }));
      check('host: an unknown schedule id is unavailable', gone && gone.code === 4004);
    }
  }

  // --- the bundled mods ---------------------------------------------------------------------------------
  const EXPECTED = {
    environment: { order: 10, permissions: ['config:read', 'session:read', 'remote'] },
    context: { order: 20, permissions: ['session:read', 'session:control'] },
    tasks: { order: 30, permissions: ['session:read'] },
    plan: { order: 35, permissions: ['session:read'] },
    outputs: { order: 40, permissions: ['session:read'] },
    'sub-sessions': { order: 45, permissions: ['session:read', 'session:control'] },
    skills: { order: 50, permissions: ['skills:read'] },
    'side-chat': { seat: 'tab', permissions: ['model', 'session:read', 'session:send'] },
    scheduled: { seat: 'tab', permissions: ['schedules', 'session:control'] },
    backgrounds: { seat: 'background', views: ['aurora', 'constellation', 'grid', 'dusk'], permissions: [] },
    'theme-midnight': { styles: ['theme.css'], permissions: [] },
    'theme-paper': { styles: ['theme.css'], permissions: [] },
    'theme-glass': { styles: ['theme.css'], permissions: [] },
    hyperspace: { seat: 'background', views: ['starfield'], looks: { holo: 'conversation', cockpit: 'composer' }, permissions: ['session:read'] },
  };
  const mods = listMods(path.join(ROOT, 'mods'));
  check('mods/ holds the bundled mods', same(mods.map((m) => m.folder).sort(), Object.keys(EXPECTED).sort()), mods.map((m) => m.folder));
  for (const m of mods) {
    const man = m.manifest || {};
    const exp = EXPECTED[m.folder] || {};
    check(`${m.folder}: mod.json has no problems`, m.valid && m.problems.length === 0, m.problems);
    check(`${m.folder}: metadata`, man.version === '1.0.0' && man.author === 'Silo Harness' && man.license === 'MIT' && typeof man.description === 'string' && man.description.length > 10 && typeof man.icon === 'string');
    const views = (man.contributes && man.contributes.views) || [];
    if (exp.styles) check(`${m.folder}: styles only, no views`, views.length === 0 && same(man.contributes.styles, exp.styles) && exp.styles.every((f) => fs.existsSync(path.join(m.dir, f))), man.contributes);
    else if (exp.seat === 'background') check(`${m.folder}: background views ${exp.views.join(', ')}, with no rail-only fields`, same(views.map((v) => v.id), exp.views) && views.every((v) => v.seat === 'background' && v.order === undefined && v.maxHeight === undefined), views);
    else if (exp.seat === 'tab') check(`${m.folder}: one tab view, with no rail-only fields`, views.length === 1 && views[0].seat === 'tab' && views[0].order === undefined && views[0].maxHeight === undefined, views);
    else check(`${m.folder}: one rail view at order ${exp.order}`, views.length === 1 && views[0].seat === 'rail' && views[0].order === exp.order, views);
    check(`${m.folder}: permissions`, same((man.permissions || []).slice().sort(), (exp.permissions || []).slice().sort()), man.permissions);
    const looks = (man.contributes && man.contributes.looks) || [];
    check(`${m.folder}: looks`, same(looks.map((l) => `${l.id}:${l.target}`), Object.entries(exp.looks || {}).map(([id, t]) => `${id}:${t}`)) && looks.every((l) => l.styles.every((f) => fs.existsSync(path.join(m.dir, f)))), looks);

    // Every harness call and event in the page is allowed by the manifest
    const granted = new Set(man.permissions || []);
    for (const v of views) {
      const html = fs.readFileSync(path.join(m.dir, v.entry), 'utf8');
      check(`${m.folder}: page loads the kit`, html.includes('/@harness/harness.js') && html.includes('/@harness/harness.css'));
      const missing = [];
      for (const [, ns, name] of html.matchAll(/harness\.(\w+)\.(\w+)\(/g)) {
        if (ns === 'storage' || ns === 'ui' || ns === 'settings' || ns === 'ready') continue;
        const method = ns === 'model' ? `model.${name}` : `${ns}.${name}`;
        if (!(method in PlaygroundHost.METHOD_PERMS)) { missing.push('unknown ' + method); continue; }
        const need = PlaygroundHost.METHOD_PERMS[method];
        if (need && !granted.has(need)) missing.push(`${method} needs ${need}`);
      }
      for (const [, ev] of html.matchAll(/harness\.on\('([\w.]+)'/g)) {
        if (!(ev in PlaygroundHost.EVENT_PERMS)) { missing.push('unknown event ' + ev); continue; }
        const need = PlaygroundHost.EVENT_PERMS[ev];
        if (need && !granted.has(need)) missing.push(`event ${ev} needs ${need}`);
      }
      check(`${m.folder}: every call and event is covered by its permissions`, missing.length === 0, missing);
    }
  }

  // --- the bundled mods follow the protocol as it now stands ------------------------------------------------
  {
    const src = (folder) => fs.readFileSync(path.join(ROOT, 'mods', folder, 'panel.html'), 'utf8');
    const skills = src('skills');
    check('skills: follows session.switched instead of polling', /harness\.on\('session\.switched'/.test(skills) && !/setInterval/.test(skills));
    const sub = src('sub-sessions');
    check('sub-sessions: follows related.changed instead of the 4-second poll', /harness\.on\('related\.changed'/.test(sub) && !/setTimeout\(load/.test(sub) && !/setInterval/.test(sub));
    check('sub-sessions: still refreshes once on visibility.changed', /harness\.on\('visibility\.changed'/.test(sub));
    const ctx = src('context');
    check('context: Compact now uses compactable from the app', /ctx\.compactable/.test(ctx) && !/key === 'messages' \|\| s\.key === 'toolResults'/.test(ctx));
    const env = src('environment');
    check('environment: shortens paths with home from config.get', /config\.home/.test(env) && !/\\\/Users\\\//.test(env));
    check('environment: reads the config again when the session switches', /harness\.on\('session\.switched'/.test(env));
    const tasks = src('tasks');
    check('tasks: no paused spinner; a still half-filled circle when no run is going', !/paused/.test(tasks) && /running \? '<span class="h-spin sm"><\/span>' : ICON\.half/.test(tasks));
  }

  // --- Side chat ------------------------------------------------------------------------------------------
  {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'mods/side-chat/mod.json'), 'utf8'));
    const html = fs.readFileSync(path.join(ROOT, 'mods/side-chat/panel.html'), 'utf8');
    check('side-chat: the description says it uses the model', /model/i.test(man.description) && /token/i.test(man.description), man.description);
    check('side-chat: icon is message', man.icon === 'message');
    check('side-chat: streams with model.complete and an onDelta, cancels with model.cancel', /harness\.model\.complete\(\{[^)]*\}, \(delta\)/.test(html) && /harness\.model\.cancel\(\)/.test(html));
    check('side-chat: the switch maps to context session or none', /context: include \? 'session' : 'none'/.test(html));
    check('side-chat: keeps the conversation per session', /harness\.storage\.session\.(get|set)\('chat'/.test(html));
    check('side-chat: follows session.switched and puts answers in the composer', /harness\.on\('session\.switched'/.test(html) && /harness\.composer\.insert\(/.test(html));
    check('side-chat: Enter sends unless Shift is held or an IME is composing', /e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing/.test(html));
  }

  // --- Scheduled ----------------------------------------------------------------------------------------------
  {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'mods/scheduled/mod.json'), 'utf8'));
    const html = fs.readFileSync(path.join(ROOT, 'mods/scheduled/panel.html'), 'utf8');
    check('scheduled: icon is clock', man.icon === 'clock');
    for (const call of ['list', 'create', 'update', 'remove', 'runNow']) check(`scheduled: uses schedules.${call}`, html.includes(`harness.schedules.${call}(`));
    check('scheduled: follows schedules.changed', /harness\.on\('schedules\.changed'/.test(html));
    check('scheduled: opens a run\'s session with sessions.open', /harness\.sessions\.open\(/.test(html));
    check('scheduled: Esc closes the delete confirmation', /e\.key !== 'Escape'/.test(html) && /confirming = null/.test(html));
    check('scheduled: catches a past time, under five minutes and an empty prompt before sending', /has passed/.test(html) && /every 5 minutes/.test(html) && /errors\.prompt/.test(html));
    // The page's own date handling: a local date and time become ISO with this machine's offset
    const iso = /function isoLocal[\s\S]*?\n  \}/.exec(html);
    const pad = (n) => String(n).padStart(2, '0');
    const isoLocal = iso && new Function('pad', iso[0] + '; return isoLocal;')(pad);
    const at = isoLocal && isoLocal('2026-11-06', '09:00');
    check('scheduled: a local time becomes ISO with an offset that means the same moment', at && /^2026-11-06T09:00:00[+-]\d\d:\d\d$/.test(at) && new Date(Date.parse(at)).getHours() === 9, at);
  }

  // --- The look mods: backgrounds and the Midnight theme ------------------------------------------------------
  {
    const read = (f) => fs.readFileSync(path.join(ROOT, 'mods', f), 'utf8');
    const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
    /** [selector, body] of every rule, with @media wrappers opened */
    const rules = (css) => [...noComments(css).replace(/@media[^{]*\{([\s\S]*?\})\s*\}/g, '$1').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);

    // Backgrounds: cheap and well-behaved
    const bg = read('backgrounds/background.html');
    const man = JSON.parse(read('backgrounds/mod.json'));
    const fps = [...bg.matchAll(/fps: (\d+)/g)].map((m) => Number(m[1]));
    check('backgrounds: every animated kind runs at 30 frames a second or less, and the loop caps it at 30', fps.length === 3 && fps.every((n) => n <= 30) && /Math\.min\(30, KINDS\[kind\]\.fps\)/.test(bg), fps);
    check('backgrounds: the canvas is never more than 1.5 device pixels', /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.5, maxScale\)/.test(bg) && [...bg.matchAll(/maxScale: ([\d.]+)/g)].every((m) => Number(m[1]) <= 1.5));
    check('backgrounds: pauses when hidden (visibility.changed and the document), holds still for reduced motion', /harness\.on\('visibility\.changed'/.test(bg) && /visibilitychange/.test(bg) && /document\.visibilityState/.test(bg) && /prefers-reduced-motion: reduce/.test(bg));
    check('backgrounds: colours from the tokens and theme.changed, settings from settings.get and settings.changed', /harness\.on\('theme\.changed'/.test(bg) && /token\('--accent'\)/.test(bg) && /token\('--bg-100'\)/.test(bg) && /harness\.settings\.get\(\)/.test(bg) && /harness\.on\('settings\.changed'/.test(bg));
    check('backgrounds: no hard-coded colours outside the token fallbacks', !/#[0-9a-f]{3,6}\b/i.test(bg.replace(/'#010203'|\/\^#010203\$\/i/g, '')));
    const settings = Object.fromEntries((man.contributes.settings || []).map((s) => [s.key, s]));
    check('backgrounds: settings intensity (subtle, medium, vivid) and speed (slow, normal)', same(settings.intensity && settings.intensity.options, ['subtle', 'medium', 'vivid']) && same(settings.speed && settings.speed.options, ['slow', 'normal']));
    check('backgrounds: asks for no permissions', same(man.permissions, []));

    // The app's own palette, Midnight and Paper: tokens only, the app's three selectors, and contrast measured from the files
    const appCss = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
    const tokenBlocks = (css) => rules(css).filter((r) => /^:root/.test(r[0])).map(([sel, body]) => [sel, Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]))]);
    const appBlocks = tokenBlocks(appCss.slice(0, appCss.indexOf('/* ---------- Base')));
    const appDark = rules(appCss.slice(appCss.indexOf('@media (prefers-color-scheme: dark)'), appCss.indexOf('/* ---------- Base')))[0][1];
    const appDarkNames = [...appDark.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).filter((n) => !/^--(git|diff)-/.test(n));
    const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    // A token's value in a scheme: the theme's own declaration, else the app's for that scheme (var() followed)
    const resolve = (d, name, base) => { const get = (n) => (n in d ? d[n] : base[n]); let v = get(name); for (let i = 0; i < 6 && v && /^var\(/.test(v); i++) v = get(/var\((--[\w-]+)/.exec(v)[1]); return v; };
    const contrast = (label, d, base, opts) => {
      const low = [];
      for (const surface of opts.surfaces) {
        for (const [fg, min] of opts.text) {
          const r = ratio(resolve(d, fg, base), resolve(d, surface, base));
          if (r < min) low.push(`${fg} on ${surface}: ${r.toFixed(2)}`);
        }
      }
      for (const tok of opts.syntax === false ? [] : ['--tok-kw', '--tok-str', '--tok-num', '--tok-com']) {
        const r = ratio(resolve(d, tok, base), resolve(d, '--code-bg', base));
        if (r < (tok === '--tok-com' ? 3 : 4.5)) low.push(`${tok} on --code-bg: ${r.toFixed(2)}`);
      }
      const btn = ratio(resolve(d, '--button-text', base), resolve(d, '--button-fill', base));
      if (btn < opts.button) low.push(`--button-text on --button-fill: ${btn.toFixed(2)}`);
      check(`${label}: text and muted text on every surface, syntax colours on code, the confirming button's label on its fill`, low.length === 0, low);
    };
    // The app: no colour fills a button; text 4.5:1 and muted text 4.5:1 on every surface; links, red and green 4.5:1 on the page and cards
    const [appLight, appDarkDecls] = [appBlocks[0][1], appBlocks[1][1]];
    for (const [label, d] of [['light', appLight], ['dark', { ...appLight, ...appDarkDecls }]]) {
      contrast(`the app ${label}`, d, d, { surfaces: ['--bg-000', '--bg-100', '--bg-200', '--bg-300', '--bubble', '--code-bg', '--field-bg'], text: [['--text-100', 4.5], ['--text-200', 4.5], ['--text-400', 4.5]], button: 4.5 });
      contrast(`the app ${label}, coloured text`, d, d, { surfaces: ['--bg-000', '--bg-100', '--bg-200', '--bg-300'], text: [['--accent', 4.5], ['--danger', 4.5], ['--success', 4.5], ['--warn', 4.5]], button: 4.5 });
      const fill = resolve(d, '--button-fill', d);
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16));
      check(`the app ${label}: the confirming button's fill is a grey`, r === g && g === b, fill);
    }
    for (const [mod, opts] of [
      ['theme-midnight', { light: { surfaces: ['--bg-000', '--bg-100', '--bg-200', '--bg-300'], text: [['--text-100', 4.5], ['--text-200', 4.5], ['--text-400', 3], ['--accent', 4.5], ['--danger', 4.5], ['--success', 4.5]], button: 4.5 } }],
      // Paper is 0.4.0's palette as it was: its terracotta is 3:1 under white labels and as link text, and its syntax,
      // red and green colours are 0.4.0's too; only the text tokens are held to the line here
      ['theme-paper', { light: { surfaces: ['--bg-000', '--bg-100', '--bg-200', '--bg-300'], text: [['--text-100', 4.5], ['--text-200', 4.5], ['--text-400', 3]], button: 3, syntax: false } }],
    ]) {
      const theme = read(`${mod}/theme.css`);
      const themeRules = rules(theme);
      check(`${mod}: only the three selectors the app declares its tokens with`, same(themeRules.map((r) => r[0]), [':root', ':root:not([data-theme="light"])', ':root[data-theme="dark"]']) && /@media \(prefers-color-scheme: dark\)/.test(theme), themeRules.map((r) => r[0]));
      const decls = themeRules.map(([, body]) => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])));
      check(`${mod}: sets nothing but custom properties`, decls.every((d) => Object.keys(d).every((k) => k.startsWith('--'))));
      check(`${mod}: the two dark blocks are the same`, same(decls[1], decls[2]));
      check(`${mod}: sets every dark token the app sets (git and diff colours aside)`, appDarkNames.every((n) => n in decls[2]), appDarkNames.filter((n) => !(n in decls[2])));
      const lightNames = Object.keys(appLight).filter((n) => n.startsWith('--') && !/^--(git|diff|fs|lh|font|mono|r|sidebar|col|shadow|backdrop)(-|$)/.test(n));
      check(`${mod}: sets every colour token the app sets in light`, lightNames.every((n) => n in decls[0]), lightNames.filter((n) => !(n in decls[0])));
      contrast(`${mod} light`, decls[0], appLight, opts.light);
      contrast(`${mod} dark`, { ...decls[0], ...decls[2] }, { ...appLight, ...appDarkDecls }, opts.light);
    }
  }

  // --- Glass: materials, not colours ------------------------------------------------------------------------
  // Its tokens come first, with the app's three selectors and the same dark values twice, and are only its own
  // --glass-… ones plus the shadows, the backdrop and three radii (no colour of text or surface changes, so the
  // app's contrast holds); with Reduce transparency on, every tint is an app surface and the blur is 0. The rules
  // after them give the sidebar, the side pane and the rail, the chat bar, the cards, menus and dialogs a tint and a
  // backdrop filter; the reading column is the page colour; nothing touches the transcript's text.
  {
    const css = fs.readFileSync(path.join(ROOT, 'mods/theme-glass/theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    /** Top-level statements: { prelude, body } */
    const statements = (text) => {
      const out = [];
      let depth = 0;
      let start = 0;
      let open = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
          if (depth++ === 0) open = i;
        } else if (text[i] === '}' && --depth === 0) {
          out.push({ prelude: text.slice(start, open).trim(), body: text.slice(open + 1, i) });
          start = i + 1;
        }
      }
      return out;
    };
    const decls = (body) => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
    /** Every rule, with @media and @supports opened: [prelude, declarations] */
    const flat = (text) => statements(text).flatMap((s) => (/^@(media|supports)/.test(s.prelude) ? flat(s.body) : [[s.prelude, decls(s.body)]]));
    const top = statements(css);
    const darkMedia = top[1] && /^@media \(prefers-color-scheme: dark\)$/.test(top[1].prelude) ? statements(top[1].body) : [];
    check('glass: its tokens come first, with the three selectors the app declares its tokens with', top[0].prelude === ':root' && darkMedia.length === 1 && darkMedia[0].prelude === ':root:not([data-theme="light"])' && top[2].prelude === ':root[data-theme="dark"]', top.slice(0, 3).map((s) => s.prelude));
    const [light, darkA, darkB] = [decls(top[0].body), decls(darkMedia[0]?.body || ''), decls(top[2].body)];
    check('glass: the two dark blocks are the same, and set what the light one sets', same(darkA, darkB) && same(Object.keys(light).sort(), Object.keys(darkB).sort()), Object.keys(light).filter((k) => !(k in darkB)));
    const allowed = /^--(glass-[\w-]+|shadow-(sm|bar|pop|dialog)|backdrop|r-(composer|pop|card-lg))$/;
    const names = [...new Set([...Object.keys(light), ...Object.keys(darkB)])];
    check('glass: changes no colour of text or surface: only its own --glass-… tokens, the shadows, the backdrop and three radii', names.length > 20 && names.every((n) => allowed.test(n)), names.filter((n) => !allowed.test(n)));
    check('glass: the reading column is the page colour in both schemes', light['--glass-page'] === 'var(--bg-100)' && darkB['--glass-page'] === 'var(--bg-100)');
    const reduced = top.find((s) => /^@media \(prefers-reduced-transparency: reduce\)$/.test(s.prelude));
    const reducedDecls = reduced ? decls(statements(reduced.body)[0].body) : {};
    check('glass: with Reduce transparency on, every tint is an app surface and the blur is 0', reduced && statements(reduced.body)[0].prelude === ':root, :root:not([data-theme="light"]), :root[data-theme="dark"]' && reducedDecls['--glass-blur'] === '0px' && Object.entries(reducedDecls).every(([k, v]) => k === '--glass-blur' || /^var\(--(bg-\d{3}|field-bg|surface-hover|bubble)\)$/.test(v)), reducedDecls);
    const tokenSelectors = [':root', ':root:not([data-theme="light"])', ':root[data-theme="dark"]', ':root, :root:not([data-theme="light"]), :root[data-theme="dark"]'];
    const rules = flat(css).filter(([sel]) => !tokenSelectors.includes(sel));
    const has = (part, prop) => rules.some(([sel, d]) => sel.split(',').some((s) => s.trim() === part) && prop in d);
    const material = (part) => has(part, 'background') && has(part, 'backdrop-filter') && has(part, '-webkit-backdrop-filter');
    check('glass: the sidebar, the side pane, the rail, the chat bar, the approval card, menus and dialogs are tinted and blurred', ['.sidebar', '.side-pane', '.mod-rail', '.composer', '.approval', '.popover', 'dialog.dialog'].every(material), ['.sidebar', '.side-pane', '.mod-rail', '.composer', '.approval', '.popover', 'dialog.dialog'].filter((p) => !material(p)));
    check('glass: the canvas is the theme\'s, the window\'s own surface is clear, the reading column is the veil', has('html', 'background') && has('body', 'background') && rules.some(([sel, d]) => sel === '.main' && d.background === 'transparent') && rules.some(([sel, d]) => sel === '.transcript-wrap' && d.background === 'var(--glass-page)'));
    check('glass: with a background mod the reading column lets it through and the panes keep their tint', rules.some(([sel, d]) => sel === ':root.mod-bg .transcript-wrap' && d.background === 'transparent') && rules.some(([sel]) => sel === ':root.mod-bg .sidebar'));
    const text = rules.map(([sel]) => sel).filter((sel) => /\.md\b|\.msg\.assistant|\.code-block|\.thinking|\.tool\b|\.tool-group|\.diff\b|\.transcript >|#messages/.test(sel));
    check('glass: nothing touches the transcript\'s text', text.length === 0, text);
    check('glass: every backdrop filter has its -webkit- twin', rules.every(([, d]) => ('backdrop-filter' in d) === ('-webkit-backdrop-filter' in d)), rules.filter(([, d]) => ('backdrop-filter' in d) !== ('-webkit-backdrop-filter' in d)).map(([s]) => s));
  }

  // --- the manifest rules themselves -----------------------------------------------------------------------
  {
    const good = { protocol: 1, id: 'word-count', name: 'Word count', version: '0.1.0', permissions: ['session:read'], contributes: { views: [{ id: 'main', title: 'W', entry: 'panel.html', seat: 'rail' }] } };
    const errs = (m, opts) => validateManifest(m, Object.assign({ folder: 'word-count', exists: (p) => p === 'panel.html' }, opts)).filter((p) => p.level === 'error').map((p) => p.message);
    check('rules: the docs example is valid', errs(good).length === 0, errs(good));
    const bad = (label, patch, re, opts) => {
      const m = JSON.parse(JSON.stringify(good));
      patch(m);
      const e = errs(m, opts);
      check(`rules: ${label}`, e.some((x) => re.test(x)), e);
    };
    bad('protocol must be 1', (m) => { m.protocol = 2; }, /protocol/);
    bad('id pattern', (m) => { m.id = 'Word_Count'; }, /lower-case/);
    bad('id must match the folder', (m) => { m.id = 'other-name'; }, /folder/);
    bad('id is at least 2 characters', (m) => { m.id = 'w'; }, /2 to 40/, { folder: 'w' });
    bad('version is major.minor.patch', (m) => { m.version = '1.0'; }, /major\.minor\.patch/);
    bad('name is required', (m) => { delete m.name; }, /name/);
    bad('seat must be known', (m) => { m.contributes.views[0].seat = 'floating'; }, /seat/);
    bad('entry must exist', (m) => { m.contributes.views[0].entry = 'missing.html'; }, /does not exist/);
    bad('entry must stay in the mod', (m) => { m.contributes.views[0].entry = '../x.html'; }, /inside the mod/);
    bad('view ids are unique', (m) => { m.contributes.views.push(Object.assign({}, m.contributes.views[0])); }, /twice/);
    bad('a command names an existing view', (m) => { m.contributes.commands = [{ name: 'wc', description: 'd', view: 'nope' }]; }, /not one of/);
    bad('select settings need options', (m) => { m.contributes.settings = [{ key: 'u', type: 'select', title: 'U', options: [] }]; }, /options/);
    bad('a default matches its type', (m) => { m.contributes.settings = [{ key: 'b', type: 'boolean', title: 'B', default: 'yes' }]; }, /default/);
    check('rules: invalid JSON is reported', validateManifest('{nope', {}).some((p) => /JSON/.test(p.message)));
    const warns = validateManifest(Object.assign({}, good, { permissions: ['session:read', 'telepathy'] }), { folder: 'word-count' });
    check('rules: an unknown permission is a warning, not an error', warns.some((p) => p.level === 'warning' && /telepathy/.test(p.message)) && !warns.some((p) => p.level === 'error'));
    const reserved = validateManifest(Object.assign({}, good, { contributes: { views: [{ id: 'm', title: 'M', entry: 'panel.html', seat: 'status' }] } }), { folder: 'word-count' });
    check('rules: a reserved seat is a warning', reserved.some((p) => p.level === 'warning' && /reserved/.test(p.message)) && !reserved.some((p) => p.level === 'error'));
  }

  done();
})().catch((e) => { console.error(e); process.exit(1); });
