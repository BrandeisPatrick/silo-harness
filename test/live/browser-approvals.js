// Live check of the agent's approvals in the real app, with the mock model scripted to call the browser tools and the
// fixture site from support/site.js, reached as fixture.example (mapped to 127.0.0.1 with --host-resolver-rules) so
// that it is not one of the exempt local hosts: the site card in the transcript with its title, its wider answers and
// the model's reason in grey; "for this session" from the menu and from the A key; a redirect to the second port
// asking again; a local file outside the project asking with its path; browser_type into the password field refused,
// the field left empty; the amber note on a sign-in page; a "Pay now" click asking with Allow and Deny only, and Deny
// reaching the model as the DENIED text; "Always allow" saved in the config; and in plan mode browser_click refused.
// Run: npm run build && node test/live/browser-approvals.js [screenshot-dir]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep, evalAt } = require('./rig.js');
const { startSite } = require('./support/site.js');

const { check, done } = checker();

const DENIED = 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.';
const HOSTS = ['--host-resolver-rules=MAP fixture.example 127.0.0.1, MAP *.fixture.example 127.0.0.1'];
const SECRET = 'Live-Approvals-Pw-42';

/** Records every approval card the transcript draws, so a card that comes and goes (answered) is still seen. */
const WATCH = `(() => {
  if (window.__cards) return true;
  window.__cards = [];
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches('.approval.prompt-card')) window.__cards.push(n); })
    .observe(document.querySelector('#messages'), { childList: true, subtree: true });
  return true;
})()`;

/** What card `i` shows, read while it is on screen; colours as computed, with the grey and the amber of the theme to compare. */
const describe = (i) => `(() => {
  const c = window.__cards[${i}];
  const probe = (v) => { const s = document.createElement('span'); s.style.color = 'var(' + v + ')'; document.body.append(s); const col = getComputedStyle(s).color; s.remove(); return col; };
  return {
    title: c.querySelector('.title')?.textContent ?? '',
    action: c.querySelector('pre.args.prose')?.textContent ?? '',
    texts: [...c.querySelectorAll('.approval-body > p.prompt-text')].map((p) => ({ text: p.textContent, cls: p.className, color: getComputedStyle(p).color })),
    grey: probe('--text-400'),
    amber: probe('--warn'),
    buttons: [...c.querySelectorAll('.prompt-foot .btn')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim()),
    more: Boolean(c.querySelector('.btn.more')),
    code: c.querySelector('.cmd code')?.textContent ?? null,
  };
})()`;

(async () => {
  const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-shots-'));
  const site = await startSite();
  const P = new URL(site.base).port;
  const Q = new URL(site.other).port;
  const A = `http://fixture.example:${P}`;
  const B = `http://fixture.example:${Q}`;
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-live-outside-'));
  const outsideFile = path.join(outsideDir, 'notes.html');
  fs.writeFileSync(outsideFile, '<!doctype html><title>Notes</title><p>Private notes.</p>');

  let app = await launch({ mode: 'ask', mock: true, args: HOSTS });
  await app.evaluate(WATCH);

  /**
   * One tool call through the mock model; each card that comes up is described and answered with the next of
   * `answers` ('once', 'deny', 'session-menu', 'session-key', 'always-menu'), or denied when none is left. Returns the
   * result the model got and the cards.
   */
  async function call(name, args, answers = []) {
    const seen = await app.evaluate('window.__cards.length');
    let result;
    let settled = false;
    const pending = app.callTool(name, args).then((r) => {
      result = r;
      settled = true;
    });
    const cards = [];
    while (!settled) {
      const count = await app.evaluate('window.__cards.length');
      if (count > seen + cards.length) {
        const i = seen + cards.length;
        await sleep(100);
        const card = await app.evaluate(describe(i));
        cards.push(card);
        const answer = answers[cards.length - 1] ?? 'deny';
        // A picture of the card (the hidden window may not have played its short fade-in yet: it can come out pale)
        if (answer === 'shot') await app.screenshotOf(path.join(shots, `card-${i}.png`), '#messages .approval.prompt-card:not(.done)', 8);
        await answerCard(i, answer, card);
      }
      await sleep(80);
    }
    await pending;
    return { result, cards, card: cards[0] };
  }

  /** Answers card `i` the way a person would. */
  async function answerCard(i, answer, card) {
    const c = `window.__cards[${i}]`;
    if (answer === 'once') return app.evaluate(`${c}.querySelector('.btn.allow').click()`);
    if (answer === 'session-key') {
      await app.evaluate(`document.querySelector('#input').focus()`);
      return app.key('a');
    }
    if (answer === 'session-menu' || answer === 'always-menu') {
      await app.evaluate(`${c}.querySelector('.btn.more').click()`);
      await app.waitFor(`document.querySelectorAll('.scope-menu .pop-item').length === 2`, 5000, 'the scope menu');
      card.menu = await app.evaluate(`[...document.querySelectorAll('.scope-menu .pop-item')].map((b) => ({ label: b.querySelector('.pop-title').textContent, hint: b.querySelector('.pop-hint')?.textContent ?? '' }))`);
      return app.evaluate(`[...document.querySelectorAll('.scope-menu .pop-item')][${answer === 'session-menu' ? 0 : 1}].click()`);
    }
    return app.evaluate(`${c}.querySelector('.btn.deny').click()`);
  }

  /** The decision line on the last row of a tool. */
  const decision = (tool) => app.evaluate(`(() => { const rows = [...document.querySelectorAll('.tool[data-tool="${tool}"]')]; return rows.pop()?.querySelector('.tool-decision')?.textContent ?? ''; })()`);

  try {
    // ---------- The site card, the menu's "for this session" ----------
    const why = 'To open the fixture landing page for the test.';
    let r = await call('browser_navigate', { url: `${A}/landing.html`, reason: why }, ['session-menu']);
    const c1 = r.card;
    check('a navigation to a site the user has not allowed shows the site card in the transcript', r.cards.length === 1 && c1.title === `Let the agent use fixture.example:${P}?`, c1);
    check('… the action under the title', c1.action === `Open fixture.example:${P}`, c1.action);
    const reasonLine = c1.texts.find((t) => t.text === why);
    check('… and the model\'s reason under it, in grey', reasonLine && reasonLine.color === c1.grey, { texts: c1.texts, grey: c1.grey });
    check('… Deny, Allow once and the ⌄ for the wider answers', c1.buttons.includes('Deny') && c1.buttons.includes('Allow once') && c1.more, c1.buttons);
    check('… whose menu has the site\'s two answers, with their keys', c1.menu && c1.menu[0].label === `Allow fixture.example:${P} for this session` && c1.menu[0].hint === 'A' && c1.menu[1].label === `Always allow fixture.example:${P}` && c1.menu[1].hint === 'P', c1.menu);
    check('allowed for the session: the page opened', /^Now at <page_content site="fixture\.example:\d+">http:\/\/fixture\.example:\d+\/landing\.html — "Landing"/.test(r.result ?? '') && !String(r.result).includes(why), r.result);
    check('… and the row says so, naming the site', (await decision('browser_navigate')) === `Allowed fixture.example:${P} for this session`, await decision('browser_navigate'));

    r = await call('browser_read_page', {});
    check('browser_read_page on that site runs without a card', r.cards.length === 0 && (r.result ?? '').startsWith(`<page_content site="fixture.example:${P}">URL: ${A}/landing.html`), r.result);

    // ---------- A redirect to another site asks again ----------
    r = await call('browser_navigate', { url: `${A}/redirect-named.html` });
    check('a navigation on the allowed site runs, and the redirect lands on the second port', r.cards.length === 0 && (r.result ?? '').startsWith(`Now at <page_content site="fixture.example:${Q}">${B}/other.html`), r.result);
    r = await call('browser_read_page', {}, ['session-key']);
    check('the next read asks again: the second port is another site', r.cards.length === 1 && r.card.title === `Let the agent use fixture.example:${Q}?` && r.card.action === `Read fixture.example:${Q}`, r.card);
    check('… the A key allows it for the session', (r.result ?? '').startsWith(`<page_content site="fixture.example:${Q}">URL: ${B}/other.html`) && (await decision('browser_read_page')) === `Allowed fixture.example:${Q} for this session`, r.result);

    // ---------- A local file outside the project ----------
    r = await call('browser_navigate', { url: `file://${outsideFile}` }, ['shot']);
    check('a local file outside the project asks, with its path', r.cards.length === 1 && r.card.title === 'Let the agent read a local file?' && r.card.action.startsWith('Read the local file ') && r.card.action.includes('notes.html'), r.card);
    check('… denied, the model reads DENIED', r.result === DENIED, r.result);

    // ---------- Credentials ----------
    r = await call('browser_navigate', { url: `${A}/login.html` });
    check('the login page opens (its site is allowed)', r.cards.length === 0 && /"Sign in"/.test(r.result ?? ''), r.result);
    const login = await app.pageTarget(`${A}/login.html`);
    r = await call('browser_type', { field: 'Password', text: SECRET });
    check('browser_type into the password field is refused, without a card', r.cards.length === 0 && /^Not permitted: passwords, one-time codes and card details are for the user to type/.test(r.result ?? ''), r.result);
    check('… and the field stays empty', (await evalAt(login, `document.getElementById('pw').value`)) === '');
    const screen = await app.evaluate(`document.querySelector('#messages').innerText`);
    check('… the text is on screen nowhere', !screen.includes(SECRET));
    r = await call('browser_press_key', { key: 'Tab', reason: 'To move to the next field.' }, ['shot']);
    const pw = r.card;
    check('an act on a page with a password field asks first, with the amber note', r.cards.length === 1 && pw.title === 'Act on a sensitive site?' && pw.texts.some((t) => t.text === 'This looks like a sign-in page' && /\bwarn\b/.test(t.cls) && t.color === pw.amber), pw);
    check('… Allow and Deny only', !pw.more && pw.buttons.join() === 'Deny,Allow once', pw.buttons);

    // ---------- A purchase ----------
    r = await call('browser_navigate', { url: `${A}/shop.html` });
    const shop = await app.pageTarget(`${A}/shop.html`);
    r = await call('browser_click', { text: 'Pay now', reason: 'The user asked me to buy it.' }, ['shot']);
    const buy = r.card;
    check('a "Pay now" click shows the purchase card', r.cards.length === 1 && buy.title === 'Make a purchase?' && buy.action === `Click "Pay now" on fixture.example:${P}`, buy);
    check('… with Allow and Deny only', !buy.more && buy.buttons.join() === 'Deny,Allow once', buy.buttons);
    check('… saying why, and the model\'s reason in grey', buy.texts.some((t) => t.text === '"Pay now" looks like a purchase.') && buy.texts.some((t) => t.text === 'The user asked me to buy it.' && t.color === buy.grey), buy.texts);
    check('Deny gives the model the DENIED text', r.result === DENIED, r.result);
    check('… nothing was bought', (await evalAt(shop, `document.body.dataset.paid || ''`)) === '');
    check('… and the row says it was denied there', (await decision('browser_click')) === `Denied on fixture.example:${P}`, await decision('browser_click'));

    // ---------- browser_eval ----------
    r = await call('browser_eval', { code: 'document.title', reason: 'To read the shop\'s title.' }, ['shot']);
    check('browser_eval on an allowed site asks in ask mode, the code in a block under the action', r.cards.length === 1 && r.card.title === `Run JavaScript on fixture.example:${P}?` && r.card.action === `Run JavaScript on fixture.example:${P}` && r.card.code === 'document.title' && !r.card.more, r.card);
    check('… denied, the code did not run', r.result === DENIED, r.result);

    // ---------- "Always allow" ----------
    const C = `http://always.fixture.example:${P}`;
    r = await call('browser_navigate', { url: `${C}/landing.html` }, ['always-menu']);
    check('a subdomain is a site of its own', r.cards.length === 1 && r.card.title === `Let the agent use always.fixture.example:${P}?`, r.card);
    const cfg = await app.evaluate('oc.getConfig()');
    check('"Always allow" puts the site into the config', Array.isArray(cfg.browser?.alwaysAllowed) && cfg.browser.alwaysAllowed.includes(`http://always.fixture.example:${P}`), cfg.browser);
    check('… not into the project\'s rules', !Object.keys(cfg.allowRules || {}).length, cfg.allowRules);
    check('… and the page opened', /^Now at <page_content site="always\.fixture\.example:\d+">http:\/\/always\.fixture\.example:\d+\/landing\.html/.test(r.result ?? '') && (await decision('browser_navigate')) === `Always allowed always.fixture.example:${P}`, r.result);
    const saved = JSON.parse(fs.readFileSync(path.join(app.profile, 'config.json'), 'utf8'));
    check('… saved on disk', saved.browser?.alwaysAllowed?.includes(`http://always.fixture.example:${P}`), saved.browser);

    const errors = app.console.filter((l) => /^\[(error|exception)\]/.test(l));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
    await app.close();

    // ---------- Plan mode ----------
    app = await launch({ mode: 'plan', mock: true, args: HOSTS });
    await app.evaluate(WATCH);
    r = await call('browser_navigate', { url: `${A}/shop.html` }, ['once']);
    check('plan mode: a navigation to a new site asks with the site card', r.cards.length === 1 && r.card.title === `Let the agent use fixture.example:${P}?` && /"Shop"/.test(r.result ?? ''), r.card);
    // Changed on purpose: the browser tools are a tool group now, offered once the session loaded it (here by the
    // navigation), so the request to look at is the latest one, not the first
    const offered = ([...app.mock.state.requests].reverse().find((q) => q.payload?.stream)?.payload.tools ?? []).map((t) => t.function.name);
    check('plan mode offers the reading browser tools, not browser_click', offered.includes('browser_read_page') && !offered.includes('browser_click') && !offered.includes('browser_type') && !offered.includes('browser_eval'), offered.filter((n) => n.startsWith('browser_')));
    r = await call('browser_click', { text: 'Pay now' });
    const planShop = await app.pageTarget(`${A}/shop.html`);
    check('plan mode: browser_click is refused, no card, nothing clicked', r.cards.length === 0 && /^(Error: unknown tool "browser_click"|Not permitted)/.test(r.result ?? '') && (await evalAt(planShop, `document.body.dataset.paid || ''`)) === '', r.result);
    console.log(`screenshots: ${shots}`);
  } finally {
    await app.close();
    site.close();
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
