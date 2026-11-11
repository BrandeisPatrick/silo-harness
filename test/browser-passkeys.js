// The guard a page's passkey requests go through, headless: page-scripts.ts passkeyGuardScript run in a small fake
// page (navigator.credentials, document) to see which requests raise the notice's event, that a request left pending
// is refused with a NotAllowedError and cancelled, and that every other request passes through untouched. The real
// thing: test/live/browser-passkeys.js.
// Run: npm run build && node test/browser-passkeys.js
const path = require('node:path');
const vm = require('node:vm');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const { passkeyGuardScript, passkeyWatchScript, PASSKEY_REFUSE_MS } = require(path.join(projectDir, 'dist/main/browser/page-scripts.js'));
const { check, done } = require('./support/check.js');

const EVENT = 'silo-passkey-test';

/** A fake page whose credentials.get/create behave as `behave` says ('hang', 'reject', 'resolve'). */
function page(behave) {
  const events = [];
  const calls = [];
  const settle = (options) => {
    calls.push(options);
    if (behave === 'resolve') return Promise.resolve({ type: 'public-key' });
    if (behave === 'reject') return Promise.reject(Object.assign(new Error('nope'), { name: 'NotSupportedError' }));
    // Pending until its signal aborts, as Electron leaves a passkey request without an authenticator
    return new Promise((_r, reject) => options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  const credentials = { get: settle, create: settle };
  const ctx = vm.createContext({ navigator: { credentials }, document: { dispatchEvent: (e) => events.push(e.type) }, Event: class { constructor(t) { this.type = t; } }, DOMException, AbortController, setTimeout, clearTimeout, Promise, Symbol, Object });
  vm.runInContext(passkeyGuardScript(EVENT), ctx);
  return { credentials, events, calls, ctx };
}

const outcome = (p, ms = PASSKEY_REFUSE_MS + 1000) => {
  const t0 = Date.now();
  return Promise.race([p.then((v) => ({ resolved: v?.type ?? String(v) }), (e) => ({ rejected: e?.name })), new Promise((r) => setTimeout(() => r({ pending: true }), ms))]).then((o) => ({ ...o, ms: Date.now() - t0 }));
};

(async () => {
  const challenge = new Uint8Array(4);

  // ---------- 1. A modal passkey request that would hang ----------
  let p = page('hang');
  let o = await outcome(p.credentials.get({ publicKey: { challenge } }));
  check('1: a modal get raises the event once and is refused with NotAllowedError, after the wait', p.events.join() === EVENT && o.rejected === 'NotAllowedError' && o.ms >= PASSKEY_REFUSE_MS - 50 && o.ms < PASSKEY_REFUSE_MS + 500, o);
  check("1: … and the request underneath is cancelled (its signal aborted), so the page's next one is not 'already pending'", p.calls[0].signal?.aborted === true);
  o = await outcome(p.credentials.create({ publicKey: { challenge, rp: { name: 'Example' }, user: { id: challenge, name: 'ada@example.com', displayName: 'Ada' }, pubKeyCredParams: [] } }));
  check('1: a modal create the same', p.events.length === 2 && o.rejected === 'NotAllowedError', o);
  o = await outcome(p.credentials.get({ publicKey: { challenge }, mediation: 'required' }));
  check("1: mediation 'required' counts as modal", p.events.length === 3 && o.rejected === 'NotAllowedError', o);

  // ---------- 2. What passes through untouched ----------
  p = page('hang');
  const ac = new AbortController();
  const cond = outcome(p.credentials.get({ publicKey: { challenge }, mediation: 'conditional', signal: ac.signal }), PASSKEY_REFUSE_MS + 300);
  o = await cond;
  check("2: a conditional request (autofill on a sign-in page) raises nothing and is left pending, as the page made it", p.events.length === 0 && o.pending && p.calls[0].signal === ac.signal, o);
  ac.abort();
  p = page('reject');
  o = await outcome(p.credentials.get({ password: true }));
  check('2: a password request raises nothing and gets its own answer', p.events.length === 0 && o.rejected === 'NotSupportedError' && p.calls[0].password === true, o);
  o = await outcome(p.credentials.get({ federated: { providers: ['https://id.example'] } }));
  check('2: a federated request raises nothing', p.events.length === 0 && o.rejected === 'NotSupportedError', o);
  o = await outcome(p.credentials.get());
  check('2: a request with no options passes through', p.events.length === 0 && o.rejected === 'NotSupportedError', o);

  // ---------- 3. A request that settles by itself keeps its own answer ----------
  p = page('reject');
  o = await outcome(p.credentials.get({ publicKey: { challenge } }));
  check("3: a modal request that fails at once: the notice's event, and the page gets that failure", p.events.length === 1 && o.rejected === 'NotSupportedError' && o.ms < 200, o);
  p = page('resolve');
  o = await outcome(p.credentials.get({ publicKey: { challenge } }));
  check('3: one that succeeds (a security key, maybe) resolves as it did', o.resolved === 'public-key', o);
  p = page('hang');
  const mine = new AbortController();
  const aborted = outcome(p.credentials.get({ publicKey: { challenge }, signal: mine.signal }));
  setTimeout(() => mine.abort(), 100);
  o = await aborted;
  check("3: the page's own abort still ends its request at once", o.rejected === 'AbortError' && o.ms < 500, o);

  // ---------- 4. Installed once per page ----------
  p = page('hang');
  vm.runInContext(passkeyGuardScript(EVENT), p.ctx);
  o = await outcome(p.credentials.get({ publicKey: { challenge } }));
  check('4: running the guard twice on one page wraps once (one event per request)', p.events.length === 1 && o.rejected === 'NotAllowedError', p.events);
  check('4: the watcher listens for that event only, and for the page going', /addEventListener\("silo-passkey-test"/.test(passkeyWatchScript(EVENT)) && /pagehide/.test(passkeyWatchScript(EVENT)));

  done();
})();
