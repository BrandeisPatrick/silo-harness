// Browser safety, headless: which form fields count as credentials (from fixture HTML, one per kind), how their
// values are hidden in tool results, browser_type's hidden text all the way to the stored transcript, and who may set
// the lists of Settings → Browser that decide where the agent acts (not a project's settings.json). The permission
// bar's policy is test/browser-permissions.js. The same code in a real page and a real window: test/live/browser-safety.js.
// Run: npm run build && node test/browser-safety.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const safety = require(path.join(projectDir, 'dist/main/browser/safety.js'));
const { createApp } = require(path.join(projectDir, 'dist/main/app.js'));
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const { credentialKind, scrubSecrets, maskedState, looksLikeCredentialLabel, typedSecretMessage, MASK, MIN_SCRUB } = safety;

/** The form fields of an HTML string, as the detection sees them (attribute names any case, values unescaped). */
function fieldsOf(html) {
  const out = [];
  for (const m of html.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
    const tag = m[1].toLowerCase();
    // As the type property reads: lower case, an unknown or missing type is "text"
    const known = /^(text|password|email|search|tel|url|number|hidden|checkbox|radio|submit|button|reset|image|file|range|color|date|time|month|week|datetime-local)$/;
    const type = tag === 'input' ? (known.test((attrs.type || '').toLowerCase()) ? attrs.type.toLowerCase() : 'text') : tag === 'textarea' ? 'textarea' : 'select-one';
    out.push({ tag, type, autocomplete: attrs.autocomplete ?? null, name: attrs.name ?? null, id: attrs.id ?? null, attrs });
  }
  return out;
}
const kindOf = (html, extra = {}) => credentialKind({ ...fieldsOf(html)[0], ...extra });

(async () => {
  // ---------- 1. Which fields are credentials ----------
  const credentials = [
    ['type=password', '<input type="password">', 'password'],
    ['type=PASSWORD in capitals', '<input type=PASSWORD name="x">', 'password'],
    ['autocomplete=current-password', '<input type="text" autocomplete="current-password">', 'password'],
    ['autocomplete=new-password', '<input autocomplete="new-password">', 'password'],
    ['autocomplete with a section and a mode', '<input autocomplete="section-login shipping current-password">', 'password'],
    ['autocomplete=one-time-code', '<input inputmode="numeric" autocomplete="one-time-code">', 'one-time code'],
    ['autocomplete=cc-number', '<input autocomplete="cc-number">', 'card'],
    ['autocomplete=cc-csc', '<input autocomplete="billing cc-csc">', 'card'],
    ['autocomplete=cc-exp on a select', '<select autocomplete="cc-exp-month"><option>01</option></select>', 'card'],
    ['autocomplete=cc-name', '<input autocomplete="cc-name">', 'card'],
    ['name=passwd', '<input name="passwd">', 'password'],
    ['name=user_pass', '<input name="user_pass">', 'password'],
    ['name=loginPassword (camel case)', '<input name="loginPassword">', 'password'],
    ['name=pwd', '<input name="pwd">', 'password'],
    ['name=session[password]', '<input name="session[password]">', 'password'],
    ['id=password_confirmation', '<input id="password_confirmation">', 'password'],
    ['a password textarea by name', '<textarea name="passphrase"></textarea>', 'password'],
    ['name=otp', '<input name="otp">', 'one-time code'],
    ['id=otp-3 (one box of six)', '<input id="otp-3" maxlength="1">', 'one-time code'],
    ['name=totp_code', '<input name="totp_code">', 'one-time code'],
    ['name=mfa_code', '<input name="mfa_code">', 'one-time code'],
    ['name=email_verification_code', '<input name="email_verification_code">', 'one-time code'],
    ['name=cvc', '<input name="cvc">', 'card'],
    ['id=CVV2', '<input id="CVV2">', 'card'],
    ['name=security_code', '<input name="security_code">', 'card'],
    ['name=cardnumber', '<input name="cardnumber">', 'card'],
    ['name=card-number', '<input name="card-number">', 'card'],
    ['id=ccNumber', '<input id="ccNumber">', 'card'],
    ['name=creditCardNumber', '<input name="creditCardNumber">', 'card'],
  ];
  for (const [label, html, kind] of credentials) check(`1: ${label} is a ${kind} field`, kindOf(html) === kind, kindOf(html));
  check('1: a password field after "Show password" (type=text, typed into while a password field) stays one', kindOf('<input type="text" name="field-7">', { wasSecret: true }) === 'password');

  const ordinary = [
    ['a username', '<input name="username" autocomplete="username">'],
    ['an email', '<input type="email" name="email" autocomplete="email">'],
    ['a search box', '<input type="search" name="q">'],
    ['a passport number', '<input name="passportNumber">'],
    ['a passenger', '<input name="passenger_name">'],
    ['a compass heading', '<input id="compass">'],
    ['a cardholder field without autocomplete', '<input name="cardholder">'],
    ['a plain textarea', '<textarea name="message"></textarea>'],
    ['a "remember password" checkbox', '<input type="checkbox" name="remember_password">'],
    ['a submit button named password_submit', '<input type="submit" name="password_submit" value="Log in">'],
    ['a plain select', '<select name="country"><option>NZ</option></select>'],
    ['a button element', '<button name="password">'],
  ];
  for (const [label, html] of ordinary) check(`1: ${label} stays readable`, kindOf(html) === null, fieldsOf(html)[0] ? kindOf(html) : 'not a field');

  // ---------- 2. How a value is hidden ----------
  check('2: a filled credential field reads = "•••"', maskedState('hunter2') === ` = "${MASK}"` && MASK === '•••');
  check('2: an empty one reads (empty)', maskedState('') === ' (empty)');
  const pw = 'S3cret-Pa55';
  check('2: a result that is the value becomes •••', scrubSecrets(pw, [pw]) === MASK);
  check('2: the value inside text is hidden', scrubSecrets(`The field holds ${pw} now`, [pw]) === `The field holds ${MASK} now`);
  const json = JSON.stringify({ email: 'ada@example.com', password: pw }, null, 2);
  const scrubbed = scrubSecrets(json, [pw]);
  check('2: in a JSON result the value is hidden and the username is not', !scrubbed.includes(pw) && scrubbed.includes(`"${MASK}"`) && scrubbed.includes('ada@example.com'), scrubbed);
  const odd = 'pa"ss\\word';
  const oddJson = JSON.stringify({ v: odd });
  check('2: a value with quotes and backslashes is found as JSON writes it', !scrubSecrets(oddJson, [odd]).includes('ss\\\\word') && scrubSecrets(oddJson, [odd]).includes(MASK), scrubSecrets(oddJson, [odd]));
  check(`2: a value shorter than ${MIN_SCRUB} characters is hidden when it stands alone`, scrubSecrets('12', ['12']) === MASK && scrubSecrets('["12","x"]', ['12']) === `["${MASK}","x"]`);
  check('2: … but not wherever its characters occur', scrubSecrets('Page 12 of 120', ['12']) === 'Page 12 of 120');
  check('2: a longer value that contains a shorter one is hidden whole', scrubSecrets('abc123456', ['abc', 'abc123456']) === MASK && scrubSecrets('x abc123456 y', ['abc', 'abc123456']) === `x ${MASK} y`);
  check('2: whitespace-only values and nothing to hide leave the text alone', scrubSecrets('a   b', ['   ']) === 'a   b' && scrubSecrets('text', []) === 'text');

  check('2: credential labels are recognised before the page is asked', ['Password', 'password', 'New password', 'Passcode', 'PIN', 'One-time code', 'OTP', 'Verification code', 'Security code', 'CVC', 'Card number', '2FA code'].every(looksLikeCredentialLabel));
  check('2: ordinary labels are not', !['Email', 'Username', 'Search', 'Passport number', 'Passenger', 'Company', 'Code of conduct'].some(looksLikeCredentialLabel));

  const typed = typedSecretMessage('password', 12, 'Password', 'ref_4', true);
  check('2: browser_type into a password field says how much, not what', typed === "Typed 12 characters into a password field 'Password' (ref_4) and pressed Enter. The text is not shown because the field holds a credential.", typed);
  check('2: … and names other kinds plainly', /into a one-time code field\b/.test(typedSecretMessage('one-time code', 6, '', undefined, false)) && /into a card field/.test(typedSecretMessage('card', 16, '', undefined, false)) && /embedded frame/.test(typedSecretMessage('embedded', 1, '', undefined, false)) && /^Typed 1 character into/.test(typedSecretMessage('card', 1, '', undefined, false)));

  // The detection's own source runs inside pages: it must not lean on anything outside itself.
  const inPage = new Function('f', `return (${credentialKind.toString()})(f);`);
  check('2: the detection works on its own, as it runs in a page', inPage({ tag: 'INPUT', type: 'password' }) === 'password' && inPage({ tag: 'INPUT', type: 'text', name: 'q' }) === null);
  for (const [label, code] of [['the page prelude', safety.inSafetyWorld('return S.secrets();')], ['the frame check', safety.frameCheckScript()]]) {
    let ok = true;
    try {
      new Function(code);
    } catch (err) {
      ok = String(err);
    }
    check(`2: ${label} is valid script`, ok === true, ok);
  }

  // ---------- 3. browser_type and browser_eval through a real agent run (a stand-in browser, the mock model) ----------
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-browser-safety-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project);
  const config = {
    provider: 'portkey',
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: project, permissionMode: 'bypass', autoApprove: true, maxTurns: 6, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  // The page: a "Code" field that is a one-time code field, an "Email" field that is not, and a "Later" field that
  // only turns into a password field once the agent types (the look before the call misses it).
  const page = { values: {}, typed: [] };
  const credentialFields = new Set(['Code', 'Later']);
  const browser = {
    // The user's own app under development (an exempt host): the agent may type into its credential fields, hidden.
    // Elsewhere they are refused before anything is typed (test/browser-approvals.js).
    state() {
      return { url: 'http://localhost:3000/login', title: 'Sign in', tabs: [], activeId: 'tab-1' };
    },
    async secretValues() {
      return Object.entries(page.values).filter(([f]) => credentialFields.has(f)).map(([, v]) => v);
    },
    async findRef(field) {
      return `ref_${['Email', 'Code', 'Later', 'Password'].indexOf(field) + 1}`;
    },
    async credentialTarget(_ref, field) {
      return field === 'Code' ? 'one-time code' : null;
    },
    async type(ref, text, submit) {
      const field = ['Email', 'Code', 'Later', 'Password'][Number(ref.slice(4)) - 1];
      page.values[field] = text;
      page.typed.push(text);
      if (credentialFields.has(field)) return { content: typedSecretMessage(field === 'Code' ? 'one-time code' : 'password', [...text].length, field, ref, submit), secret: true };
      return { content: `Typed ${JSON.stringify(text)} into textbox '${field}' (${ref}).`, secret: false };
    },
    async evaluate() {
      return JSON.stringify({ email: page.values.Email, code: page.values.Code, later: page.values.Later });
    },
  };
  const app = createApp({ userData: tmp, appRoot: projectDir, loadConfig: () => config, saveConfig: () => undefined, browser: () => browser });
  const rt = app.runtime;
  const events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  const sid = rt.foregroundId();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idle = async () => {
    for (let i = 0; i < 400 && rt.isRunning(sid); i++) await sleep(15);
  };
  const run = async (tag, toolCalls) => {
    state.replies.push({ content: '', toolCalls, when: (p) => JSON.stringify([...p.messages].reverse().find((m) => !String(m.content).startsWith('[Session context]'))).includes(tag) });
    rt.send(sid, `Step ${tag}`);
    await sleep(30);
    await idle();
  };
  const CODE = '493817';
  const LATER = 'Later-Secret-77';
  const EMAIL = 'ada@example.com';
  await run('[T1]', [
    { id: 'c1', name: 'browser_type', args: { field: 'Email', text: EMAIL } },
    { id: 'c2', name: 'browser_type', args: { field: 'Code', text: CODE } },
    { id: 'c3', name: 'browser_type', args: { field: 'Password', text: 'Typed-Into-Nothing' } },
    { id: 'c4', name: 'browser_type', args: { field: 'Later', text: LATER } },
    { id: 'c5', name: 'browser_eval', args: { code: 'JSON.stringify(...)' } },
  ]);
  const session = app.store.get(sid);
  const calls = session.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls);
  const storedArgs = (id) => JSON.parse(calls.find((c) => c.id === id).function.arguments);
  const results = Object.fromEntries(session.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]));
  const starts = Object.fromEntries(events.filter((e) => e.ev.type === 'tool_start').map((e) => [e.ev.id, e.ev.args]));
  check('3: every call ran with the real text', page.typed.includes(CODE) && page.typed.includes(LATER) && page.typed.includes(EMAIL), page.typed);
  check('3: an ordinary field keeps its text in the transcript and the result', storedArgs('c1').text === EMAIL && results.c1.includes(EMAIL) && starts.c1.text === EMAIL);
  check('3: a one-time code field: the stored call shows •••', storedArgs('c2').text === MASK, storedArgs('c2'));
  check('3: … the tool row got ••• from the start', starts.c2.text === MASK, starts.c2);
  check('3: … the result gives the length only', results.c2.startsWith('Typed 6 characters into a one-time code field') && !results.c2.includes(CODE), results.c2);
  check('3: a field named like a password is hidden before the page is asked', storedArgs('c3').text === MASK && starts.c3.text === MASK);
  check('3: a field that became a password field during the call is hidden in the stored call afterwards', storedArgs('c4').text === MASK && !results.c4.includes(LATER), { args: storedArgs('c4'), result: results.c4 });
  check('3: browser_eval shows the email but hides the code and the password', results.c5.includes(EMAIL) && !results.c5.includes(CODE) && !results.c5.includes(LATER) && results.c5.includes(MASK), results.c5);
  app.store.save(session);
  const file = fs.readFileSync(app.store.file(sid), 'utf8');
  check('3: the saved session file holds neither secret', !file.includes(CODE) && !file.includes(LATER) && file.includes(EMAIL));
  const after = state.requests.filter((r) => r.url === '/v1/chat/completions').pop();
  const sent = JSON.stringify(after?.payload?.messages ?? []);
  check('3: the next request to the model holds neither secret', after && !sent.includes(CODE) && !sent.includes(LATER) && sent.includes(EMAIL));
  mock.close();

  // ---------- 4. Settings → Browser: who may choose where the agent acts ----------
  // The permission policy that was checked here is test/browser-permissions.js now (the bar replaced the dialog).
  {
    const { SettingsLayer } = require(path.join(projectDir, 'dist/main/settings.js'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-browser-settings-'));
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(root, 'proj-')));
    fs.mkdirSync(path.join(cwd, '.silo-harness'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.silo-harness', 'settings.json'), JSON.stringify({ browser: { alwaysAllowed: ['bank.example'], exempt: ['evil.example', '/'], sensitive: ['mail.corp.example'], keepCookies: false, downloadsDir: '~/Project downloads', openChatLinksInPane: true } }));
    const userFile = path.join(root, 'user-settings.json');
    fs.writeFileSync(userFile, JSON.stringify({ browser: { alwaysAllowed: ['mine.example'], exempt: ['dev.mine.example'] } }));
    const layer = new SettingsLayer({ userFile });
    const baseCfg = { provider: 'ollama', ollama: { baseURL: 'http://localhost:11434/v1', model: 'm', numCtx: 16384, think: 'auto' }, portkey: { baseURL: 'https://api.portkey.ai/v1', apiKey: '', model: 'x', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 }, workingDirectory: cwd, permissionMode: 'ask', autoApprove: false, maxTurns: 40, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: true, mcpServers: {}, mcpTrusted: {}, autoCompact: true, notifications: true, allowRules: {}, recentDirs: [], settingsTrusted: {}, browser: { keepCookies: true, downloadsDir: '', openChatLinksInPane: false, alwaysAllowed: [], sensitive: [], exempt: [] } };
    let cfg = layer.load(baseCfg);
    cfg = layer.recompute(layer.withTrust(cfg, true));
    const proj = layer.info().files.find((f) => f.scope === 'project');
    check("4: a project's settings.json may not set the sites the agent may always use", JSON.stringify(cfg.browser.alwaysAllowed) === '["mine.example"]' && proj.invalid.some((i) => i.key === 'browser.alwaysAllowed' && /may not choose where the agent acts without asking/.test(i.message)), { cfg: cfg.browser, invalid: proj.invalid });
    check('4: … nor the exempt hosts', JSON.stringify(cfg.browser.exempt) === '["dev.mine.example"]' && proj.invalid.some((i) => i.key === 'browser.exempt'), cfg.browser.exempt);
    check('4: … the rest of its browser block applies (cookies, the downloads folder, chat links, sites that always ask)', cfg.browser.keepCookies === false && cfg.browser.downloadsDir === '~/Project downloads' && cfg.browser.openChatLinksInPane === true && JSON.stringify(cfg.browser.sensitive) === '["mail.corp.example"]' && proj.applied, cfg.browser);
    const owned = layer.info().owned;
    check('4: … so the two lists stay yours, the rest is the project\'s', owned['browser.alwaysAllowed'] === 'user' && owned['browser.exempt'] === 'user' && owned['browser.sensitive'] === 'project' && owned['browser.keepCookies'] === 'project', owned);
    const user = layer.info().files.find((f) => f.scope === 'user');
    check('4: your own settings.json may set both lists', user.invalid.length === 0 && user.keys.includes('browser.alwaysAllowed') && user.keys.includes('browser.exempt'), user);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The field that adds a site in Settings → Browser (src/renderer/settings/model.ts, an ES module: a .mjs copy loads it)
  {
    const { pathToFileURL } = require('node:url');
    const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oa-site-pattern-')), 'model.mjs');
    fs.copyFileSync(path.join(projectDir, 'dist/renderer/settings/model.js'), copy);
    const { parseSitePattern: site } = await import(pathToFileURL(copy).href);
    fs.rmSync(path.dirname(copy), { recursive: true, force: true });
    const ok = (t, o, want) => {
      const r = site(t, o);
      return r.ok && r.value === want;
    };
    check('4: sites are read as the policy matches them', ok('example.com', {}, 'example.com') && ok('*.Example.com', {}, '*.example.com') && ok('localhost:3000', {}, 'localhost:3000') && ok('[::1]:8080', {}, '[::1]:8080') && ok('https://www.example.com/some/page?q', {}, 'www.example.com'));
    check('4: an international name is stored as its ASCII form', ok('bücher.example', {}, 'xn--bcher-kva.example'));
    check('4: nonsense, spaces and an empty field are refused', !site('not a site').ok && !site('').ok && !site('exa mple.com').ok && !site('-bad-.com').ok);
    check('4: "login." is a prefix only where the list takes prefixes', !site('login.').ok && ok('login.', { prefixes: true }, 'login.'));
    check('4: a folder only where the list takes folders', !site('/Users/me/site').ok && ok('/Users/me/site/', { folders: true }, '/Users/me/site') && ok('~/site', { folders: true }, '~/site') && ok('file:///Users/me/site', { folders: true }, '/Users/me/site'));
  }

  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
