// Live check of Auto mode deciding browser actions with its safety check, in the real window with the mock model
// scripted for the agent and for the check, on the fixture site reached as fixture.example (mapped to 127.0.0.1, so
// it is not an exempt local host): allow opens a new site without a card and allows it for the session (no second
// check on the next read); block shows no card, the quiet line and the blocked result; ask shows the site card and
// the user's answer is honoured; a check that fails shows the card; an act on a sign-in page is checked each time; a
// purchase asks the user without a check; the check is never shown the page's text.
// Run: npm run build && node test/live/auto-browser.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launch, checker, sleep } = require('./rig.js');
const { startSite } = require('./support/site.js');
const { classifierReply, isClassifierRequest } = require('../support/mock-model.js');

const { check, done } = checker();

const DENIED = 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.';
const HOSTS = ['--host-resolver-rules=MAP fixture.example 127.0.0.1, MAP *.fixture.example 127.0.0.1'];

/** Records every approval card the transcript draws, so a card that comes and goes (answered) is still seen. */
const WATCH = `(() => {
  if (window.__cards) return true;
  window.__cards = [];
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && n.matches('.approval.prompt-card')) window.__cards.push(n); })
    .observe(document.querySelector('#messages'), { childList: true, subtree: true });
  return true;
})()`;

(async () => {
  const site = await startSite();
  const P = new URL(site.base).port;
  const Q = new URL(site.other).port;
  const A = `http://fixture.example:${P}`;
  const B = `http://fixture.example:${Q}`;
  const C = `http://ask.fixture.example:${P}`;
  const D = `http://down.fixture.example:${P}`;
  const app = await launch({ mode: 'auto', mock: true, args: HOSTS });
  const replies = app.mock.state.replies;
  const requests = app.mock.state.requests;
  const checkTexts = () => requests.filter((r) => isClassifierRequest(r.payload)).map((r) => JSON.stringify(r.payload.messages));
  const checks = () => checkTexts().length;
  const lastCheck = () => checkTexts().at(-1) ?? '';
  await app.evaluate(WATCH);

  /** One tool call; each card that comes up is read and answered with the next of `answers` ('once', 'deny'). */
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
        cards.push(await app.evaluate(`({ title: window.__cards[${i}].querySelector('.title')?.textContent ?? '', buttons: [...window.__cards[${i}].querySelectorAll('.prompt-foot .btn')].map((b) => (b.getAttribute('aria-label') || b.textContent).trim()) })`));
        const answer = answers[cards.length - 1] ?? 'deny';
        await app.evaluate(`window.__cards[${i}].querySelector(${JSON.stringify(answer === 'once' ? '.btn.allow' : '.btn.deny')}).click()`);
      }
      await sleep(80);
    }
    await pending;
    return { result, cards };
  }
  const quietLines = () => app.evaluate(`[...document.querySelectorAll('#messages .auto-blocked')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())`);
  const has = (text) => (p) => JSON.stringify(p.messages ?? []).includes(text);

  try {
    // ---------- allow: no card, the page loads, the site is allowed for the session ----------
    let n = checks();
    replies.push(classifierReply('allow', '[Browsing] the site the task needs', { when: has(`url: ${A}/landing.html`) }));
    let r = await call('browser_navigate', { url: `${A}/landing.html`, reason: 'MODEL-REASON-77' });
    check('allow: one check, no card, the page opened', checks() === n + 1 && r.cards.length === 0 && /^Now at <page_content site="fixture\.example:\d+">/.test(r.result ?? ''), { checks: checks() - n, r });
    check('allow: the check was told the tool, the kind, the site and the URL, not the model\'s reason', /tool: browser_navigate\\nkind: read\\nsite: fixture\.example:\d+\\nurl: http:\/\/fixture\.example:\d+\/landing\.html/.test(lastCheck()) && !lastCheck().includes('MODEL-REASON-77'), lastCheck().slice(-500));
    n = checks();
    r = await call('browser_read_page', {});
    check('allow: the site is allowed for the session, the next read runs without a check or a card', checks() === n && r.cards.length === 0 && (r.result ?? '').includes('You made it.'), { checks: checks() - n, r });
    const est = Math.ceil(lastCheck().length / 4);
    console.log(`a browser check request: ${lastCheck().length} characters, about ${est} tokens`);

    // ---------- block: no card, the quiet line, the blocked result ----------
    n = checks();
    replies.push(classifierReply('block', '[Other Site] not needed for the task', { when: has(`site: fixture.example:${Q}`) }));
    r = await call('browser_navigate', { url: `${B}/other.html` });
    check('block: no card, a blocked result', r.cards.length === 0 && (r.result ?? '').startsWith('Blocked by Auto mode: [Other Site] not needed for the task.') && checks() === n + 1, r);
    await app.waitFor(`document.querySelectorAll('#messages .auto-blocked').length > 0`, 10_000, 'the quiet line');
    const lines = await quietLines();
    check('block: the quiet line names the action', lines.some((l) => l === `Auto mode blocked open fixture.example:${Q} · Allow`), lines);

    // ---------- ask: the card, and the user's answer is honoured ----------
    n = checks();
    replies.push(classifierReply('ask', '[Unsure] a site the user did not name', { when: has('site: ask.fixture.example') }));
    r = await call('browser_navigate', { url: `${C}/landing.html` }, ['once']);
    check('ask: the site card shows, Allow once opens the page', checks() === n + 1 && r.cards.length === 1 && r.cards[0].title === `Let the agent use ask.fixture.example:${P}?` && /^Now at /.test(r.result ?? ''), r);
    n = checks();
    replies.push(classifierReply('ask', '[Unsure] a site the user did not name', { when: has('site: ask.fixture.example') }));
    r = await call('browser_read_page', {}, ['deny']);
    check('ask: Allow once allowed once; asked again, Deny reaches the agent', checks() === n + 1 && r.cards.length === 1 && r.result === DENIED, r);

    // ---------- the check fails: the card ----------
    n = checks();
    replies.push(classifierReply('allow', '', { status: 500, when: has('site: down.fixture.example') }));
    r = await call('browser_navigate', { url: `${D}/landing.html` }, ['deny']);
    check('check unavailable: the card, never an allow', checks() === n + 1 && r.cards.length === 1 && r.result === DENIED, r);

    // ---------- a sign-in page: each act is checked ----------
    r = await call('browser_navigate', { url: `${A}/login.html` });
    check('the login page opens (its site is allowed)', r.cards.length === 0 && /"Sign in"/.test(r.result ?? ''), r.result);
    n = checks();
    replies.push(classifierReply('allow', '[Sign-in] moves through the form', { when: has('note: This looks like a sign-in page') }));
    replies.push(classifierReply('allow', '[Sign-in] moves through the form', { when: has('note: This looks like a sign-in page') }));
    r = await call('browser_press_key', { key: 'Tab' });
    const r2 = await call('browser_press_key', { key: 'Tab' });
    check('sign-in page: each act goes to the check, with the note and kind act', checks() === n + 2 && r.cards.length === 0 && r2.cards.length === 0 && /kind: act/.test(lastCheck()), { checks: checks() - n, r, r2 });
    r = await call('browser_type', { field: 'Password', text: 'Made-Up-Pw-1' });
    check('credentials: still refused, without a check', /^Not permitted: passwords/.test(r.result ?? '') && checks() === n + 2, r.result);

    // ---------- a purchase: the user's, no check ----------
    r = await call('browser_navigate', { url: `${A}/shop.html` });
    n = checks();
    r = await call('browser_click', { text: 'Pay now' }, ['deny']);
    check('purchase: the card in Auto mode, without a check', r.cards.length === 1 && r.cards[0].title === 'Make a purchase?' && checks() === n && r.result === DENIED, { r, checks: checks() - n });

    // ---------- page script: a plain read runs; one that reads cookies goes to the check ----------
    n = checks();
    r = await call('browser_eval', { code: 'document.title' });
    check('eval: a plain read on an allowed site runs without a check', r.cards.length === 0 && checks() === n && (r.result ?? '').includes('Shop'), r);
    replies.push(classifierReply('block', '[Credentials] reads cookies', { when: has('kind: page script') }));
    r = await call('browser_eval', { code: 'document.cookie' });
    check('eval: reading cookies goes to the check, which blocks it', r.cards.length === 0 && checks() === n + 1 && (r.result ?? '').startsWith('Blocked by Auto mode: [Credentials] reads cookies') && /code:\\ndocument\.cookie/.test(lastCheck()), r);

    check('the check never saw page text', !checkTexts().some((t) => t.includes('You made it.') || t.includes('<page_content')));
    const errors = app.console.filter((x) => /^\[(error|exception)\]/.test(x));
    check('no renderer errors', errors.length === 0, errors.slice(0, 3));
  } finally {
    await app.close();
    site.close();
  }
  process.exit(done() ? 1 : 0);
})().catch((err) => {
  console.error('LIVE TEST CRASHED', err);
  process.exit(1);
});
