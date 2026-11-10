// The browser tools' approvals, headless: an Agent driven by the mock model with a stand-in browser (its page is a
// URL and a few facts the test sets), through the runtime as the window uses it. The site card and its scopes (for
// this session, always: saved in AppConfig.browser.alwaysAllowed for every session after), Deny, the model's reason on
// the card and nowhere else, local files, refused schemes, browser_eval in ask and auto mode, plan and bypass mode,
// purchases, accounts and CAPTCHAs, typing and keys into credential fields, the sign-in page signal, the amber note,
// PreToolUse hooks, and the renderer's wording of the cards. The same in the real app: test/live/browser-approvals.js.
// Run: npm run build && node test/browser-approvals.js
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const projectDir = process.argv[2] || path.join(__dirname, '..');
const dist = (p) => require(path.join(projectDir, 'dist/main', p));
const { createApp } = dist('app.js');
const { Agent } = dist('agent.js');
const { DENIED, decideApproval, approvalLabels } = dist('agent/permissions.js');
const { allTools } = dist('tools/index.js');
const { resolveTarget } = dist('browser/controller.js');
const { CREDENTIAL_REFUSAL, siteOf } = dist('browser/policy.js');
const { typedSecretMessage, MASK } = dist('browser/safety.js');
const { HookEngine } = dist('hooks/engine.js');
const { SessionStore } = dist('sessions.js');
const { ArtifactStore } = dist('artifacts.js');
const { startMock } = require('./support/mock-model.js');
const { check, done } = require('./support/check.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

/**
 * The stand-in browser: one tab whose page is `page.url`. Navigations resolve as the controller does; clicks land on
 * what `page.targets` says is under a ref (refs come from the element's text); typing and keys are recorded.
 */
function fakeBrowser(page) {
  const refOf = (text) => `ref_${Object.keys(page.targets).indexOf(text) + 1}`;
  const textOf = (ref) => Object.keys(page.targets)[Number(String(ref).slice(4)) - 1];
  return {
    state() {
      return { tabs: [{ id: 'tab-1', url: page.url, title: 'Page', favicon: null, loading: false, canGoBack: false, canGoForward: false, blockedPopups: 0 }], activeId: 'tab-1', url: page.url, title: 'Page', canGoBack: false, canGoForward: false, loading: false };
    },
    async navigate(target) {
      page.navigated.push(target);
      page.url = resolveTarget(target, page.url);
      return `Now at ${page.url} — "Page"`;
    },
    async openTab(target) {
      page.navigated.push(target);
      page.url = resolveTarget(target, '');
      return `Opened tab-2. Now at ${page.url} — "Page"`;
    },
    async readPage() {
      page.reads++;
      return `URL: ${page.url}\nTitle: Page\n1 interactive element\n\n[ref_1] button "Pay now"`;
    },
    async getText() {
      page.reads++;
      return `URL: ${page.url}\nTitle: Page\n\nSome text.`;
    },
    async secretValues() {
      return [];
    },
    async findRef(text) {
      if (!(text in page.targets)) throw new Error(`No element matching "${text}" on this page.`);
      return refOf(text);
    },
    async describeTarget(at) {
      if ('ref' in at) {
        const t = page.targets[textOf(at.ref)];
        return t ? { text: textOf(at.ref), role: '', tag: 'button', type: '', inCaptcha: false, formHasCardFields: false, formActionHost: null, ...t } : null;
      }
      return page.atPoint;
    },
    async click(ref) {
      page.clicked.push(textOf(ref));
      return `Clicked button '${textOf(ref)}' (${ref}).`;
    },
    clickAt(x, y) {
      page.clicked.push(`(${x}, ${y})`);
    },
    async clickPoint(x, y) {
      page.clicked.push(`(${x}, ${y})`);
      return `Clicked at (${x}, ${y}).`;
    },
    async credentialTarget(ref, field) {
      if (field) return page.fieldKinds[field] ?? null;
      if (ref) return null;
      return page.focusedKind;
    },
    async type(ref, text, submit) {
      page.typed.push(text);
      const kind = page.fieldKinds[page.lastField] ?? null;
      if (kind) return { content: typedSecretMessage(kind, [...text].length, page.lastField, ref, submit), secret: true };
      return { content: `Typed ${JSON.stringify(text)} into textbox (${ref}).`, secret: false };
    },
    async pressKey(combo) {
      page.keys.push(combo);
      return `Pressed ${combo}.`;
    },
    async evaluate(code) {
      page.evals.push(code);
      return '"Page"';
    },
    async pageHasPasswordField() {
      return page.passwordField;
    },
  };
}

(async () => {
  const mock = await startMock();
  const { state } = mock;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-browser-approvals-'));
  process.env.SILO_HARNESS_CONFIG_DIR = path.join(tmp, 'home-config');
  const project = path.join(tmp, 'project');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  const config = {
    provider: 'portkey',
    ollama: { baseURL: `http://127.0.0.1:${mock.port}/v1`, model: 'mock', numCtx: 4096, think: 'auto' },
    portkey: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'test', model: 'mock', virtualKey: '', provider: '', providerApiKey: '', configId: '', contextWindow: 128000 },
    workingDirectory: project, permissionMode: 'ask', autoApprove: false, maxTurns: 6, sendScreenshotsToModel: false, systemPromptExtra: '', theme: 'system', autoTitles: false,
    mcpServers: {}, mcpTrusted: {}, autoCompact: false, notifications: false, allowRules: {}, recentDirs: [],
  };
  const page = { url: 'about:blank', navigated: [], reads: 0, clicked: [], typed: [], keys: [], evals: [], targets: {}, atPoint: null, fieldKinds: {}, lastField: '', focusedKind: null, passwordField: false };
  const browser = fakeBrowser(page);
  // browser_type by field: the stand-in remembers which field it was, as the page would know
  const findRef = browser.findRef;
  browser.findRef = async (text, kind) => {
    if (kind === 'field') {
      page.lastField = text;
      return 'ref_9';
    }
    return findRef(text);
  };
  const saved = [];
  const app = createApp({ userData: tmp, appRoot: projectDir, loadConfig: () => config, saveConfig: (c) => saved.push(c), browser: () => browser });
  const rt = app.runtime;
  const events = [];
  app.events.on((sid, ev) => events.push({ sid, ev }));
  let sid = rt.foregroundId();
  const mode = (m) => app.updateConfig({ permissionMode: m });

  let n = 0;
  /**
   * One user turn in which the model calls `name` with `args`. `answers` answers the cards that come up, in order:
   * [ok, always, scope] (a card with no answer left is denied and counted). Returns the result the model got, the
   * cards and how they were resolved, and the stored call.
   */
  async function step(name, args, answers = []) {
    const marker = `[S${++n}]`;
    const id = `call_${n}`;
    state.replies.push({ content: '', toolCalls: [{ id, name, args }], when: (p) => JSON.stringify([...p.messages].reverse().find((m) => !String(m.content).startsWith('[Session context]'))).includes(marker) });
    const from = events.length;
    rt.send(sid, `Step ${marker}`);
    const cards = [];
    let extra = 0;
    for (;;) {
      await waitFor(() => events.slice(from).filter((e) => e.sid === sid && e.ev.type === 'approval_request').length > cards.length || (!rt.isRunning(sid) && events.slice(from).some((e) => e.sid === sid && e.ev.type === 'run_end')), 8000, `${name} to ask or finish`);
      const next = events.slice(from).filter((e) => e.sid === sid && e.ev.type === 'approval_request')[cards.length];
      if (!next) break;
      cards.push(next.ev);
      const answer = answers[cards.length - 1];
      if (answer) rt.respondApproval(next.ev.id, ...answer);
      else {
        extra++;
        rt.respondApproval(next.ev.id, false);
      }
    }
    await waitFor(() => !rt.isRunning(sid), 8000, `${name} to finish`);
    const session = rt.get(sid);
    const result = session.messages.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? null;
    const call = session.messages.filter((m) => m.role === 'assistant' && m.tool_calls).flatMap((m) => m.tool_calls).find((c) => c.id === id);
    const resolved = events.slice(from).filter((e) => e.ev.type === 'approval_resolved').map((e) => e.ev);
    return { result, cards, card: cards[0], resolved, extra, stored: call ? JSON.parse(call.function.arguments) : null };
  }
  const SESSION = [true, true, 'session'];
  const ALWAYS = [true, true, 'project'];
  const ONCE = [true, false];
  const DENY = [false, false];

  // ---------- 1. The site card and its scopes (ask mode) ----------
  page.url = 'https://example.com/';
  let r = await step('browser_read_page', {}, [SESSION]);
  check('1: a read on a new site raises the site card', r.cards.length === 1 && r.card.name === 'browser_read_page' && r.card.browser?.card === 'site' && r.card.browser.site === 'example.com', r.card);
  check('1: … with the wider answers for that site', r.card.alwaysLabel === 'Allow example.com for this session' && r.card.projectLabel === 'Always allow example.com', [r.card.alwaysLabel, r.card.projectLabel]);
  check('1: … the action as its detail, and no note on an ordinary site', r.card.detail === 'Read example.com' && r.card.note === undefined && !r.card.reason, r.card);
  check('1: answered "for this session": the call ran, resolved with scope session', /^<page_content site="example\.com">URL: https:\/\/example\.com\//.test(r.result ?? '') && r.resolved.length === 1 && r.resolved[0].ok === true && r.resolved[0].scope === 'session', { result: r.result, resolved: r.resolved });
  const reads = page.reads;
  r = await step('browser_get_text', {});
  check('1: the next call on that site runs without a card', r.cards.length === 0 && page.reads === reads + 1 && /Some text/.test(r.result ?? ''), r.result);
  page.url = 'https://www.example.com/a';
  r = await step('browser_read_page', {}, [DENY]);
  check('1: www.example.com is another site: it asks again', r.cards.length === 1 && r.card.browser?.site === 'www.example.com', r.card);
  check('1: Deny gives the model the DENIED message and does not read', r.result === DENIED && page.reads === reads + 1 && r.resolved[0].ok === false && r.resolved[0].scope === 'once', r.result);
  check('1: … and saves nothing', !(app.config().browser.alwaysAllowed || []).length && !Object.keys(app.config().allowRules || {}).length);
  page.url = 'https://example.com:8443/';
  r = await step('browser_read_page', {}, [ONCE]);
  check('1: another port is another site; "Allow once" runs that call only', r.cards.length === 1 && r.card.browser.site === 'example.com:8443' && /^<page_content site="[^"]+">URL:/.test(r.result ?? '') && r.resolved[0].scope === 'once');
  r = await step('browser_read_page', {}, [DENY]);
  check('1: … and the next call there asks again', r.cards.length === 1 && r.result === DENIED);

  // ---------- 2. "Always allow": saved on this Mac, for every session after ----------
  const first = sid;
  sid = rt.create({ cwd: project, foreground: true }).id;
  check('2: a new session has an Agent of its own', rt.agentFor(sid) !== rt.agentFor(first));
  page.url = 'https://example.com/b';
  r = await step('browser_read_page', {}, [ALWAYS]);
  check('2: a site allowed for another session asks again in this one', r.cards.length === 1 && r.card.browser.site === 'example.com');
  check('2: answered "Always": the call ran, resolved with scope project', /^<page_content site="[^"]+">URL:/.test(r.result ?? '') && r.resolved[0].scope === 'project', r.resolved);
  check('2: … config.browser.alwaysAllowed holds the site key', JSON.stringify(app.config().browser.alwaysAllowed) === '["example.com"]', app.config().browser);
  check('2: … saved to config.json, and not as a project rule', saved.length > 0 && saved.at(-1).browser.alwaysAllowed.includes('example.com') && !Object.keys(app.config().allowRules || {}).length, saved.at(-1)?.allowRules);
  r = await step('browser_find', { query: 'x' });
  check('2: the same run goes on without a card', r.cards.length === 0);
  sid = rt.create({ cwd: project, foreground: true }).id;
  page.url = 'https://example.com/c';
  r = await step('browser_read_page', {});
  check('2: a new Agent on the same config does not ask', r.cards.length === 0 && /^<page_content site="[^"]+">URL:/.test(r.result ?? ''), r.result);
  // A second "Always" adds to the list without repeating it
  page.url = 'https://docs.example.org/';
  r = await step('browser_read_page', {}, [ALWAYS]);
  check('2: a second site joins the list', JSON.stringify(app.config().browser.alwaysAllowed) === '["example.com","docs.example.org"]', app.config().browser.alwaysAllowed);

  // ---------- 3. The model's reason, navigations, local files, refused schemes ----------
  const why = 'To read the release notes the user asked about.';
  r = await step('browser_navigate', { url: 'https://news.example/notes', reason: why }, [ONCE]);
  check('3: browser_navigate to a new site asks with the destination\'s card', r.cards.length === 1 && r.card.browser.site === 'news.example' && r.card.browser.card === 'site', r.card);
  check('3: the reason is on the card, on the line under the action', r.card.detail === `Open news.example\n${why}`, r.card.detail);
  check('3: … and not in the result', r.result && r.result.startsWith('Now at https://news.example/notes') && !r.result.includes(why), r.result);
  check('3: the navigation ran once allowed', page.navigated.at(-1) === 'https://news.example/notes');
  r = await step('browser_navigate', { url: 'about:blank' });
  check('3: about:blank needs no card', r.cards.length === 0 && page.url === 'about:blank');
  const secretFile = path.join(outside, 'secret.html');
  const navCount = page.navigated.length;
  r = await step('browser_navigate', { url: `file://${secretFile}` }, [DENY]);
  check('3: a file outside the working directory asks, with its path in the detail', r.cards.length === 1 && r.card.browser.card === 'site' && r.card.detail.includes(siteOf(`file://${secretFile}`).display) && /^Read the local file /.test(r.card.detail), r.card);
  check('3: … denied, it is not opened', r.result === DENIED && page.navigated.length === navCount);
  r = await step('browser_navigate', { url: `file://${path.join(project, 'index.html')}` });
  check('3: a file inside the working directory opens without a card', r.cards.length === 0 && page.navigated.at(-1) === `file://${path.join(project, 'index.html')}`, r.result);
  r = await step('browser_navigate', { url: 'javascript:alert(1)' });
  check('3: javascript: is refused without a card', r.cards.length === 0 && /^Not permitted: the browser does not open javascript: URLs/.test(r.result ?? '') && /create_artifact/.test(r.result), r.result);
  r = await step('browser_tabs', { action: 'new', url: 'data:text/html,<b>hi</b>' });
  check('3: … data: in a new tab too', r.cards.length === 0 && /^Not permitted/.test(r.result ?? ''), r.result);
  page.url = 'https://example.com/';
  r = await step('browser_navigate', { url: 'docs.example.net' }, [DENY]);
  check('3: a bare host resolves as the URL bar does, and its site asks', r.cards.length === 1 && r.card.browser.site === 'docs.example.net', r.card);
  r = await step('browser_navigate', { url: 'release notes' }, [DENY]);
  check('3: a search phrase is a visit to the search engine', r.cards.length === 1 && r.card.browser.site === 'duckduckgo.com', r.card);
  r = await step('browser_tabs', { action: 'new', url: 'https://tabs.example/' }, [DENY]);
  check('3: browser_tabs new asks for where it goes', r.cards.length === 1 && r.card.browser.site === 'tabs.example' && r.card.detail === 'Open a new tab at tabs.example', r.card);
  page.url = 'https://unasked.example/';
  r = await step('browser_tabs', { action: 'list' }, [DENY]);
  check('3: listing the tabs on a site never allowed asks nothing', r.cards.length === 0 && !/Not permitted/.test(r.result ?? ''), r);
  page.url = 'about:blank';

  // ---------- 4. browser_eval ----------
  page.url = 'https://example.com/';
  r = await step('browser_eval', { code: 'document.title', reason: 'To check the title.' }, [ONCE]);
  check('4: ask mode: browser_eval on an allowed site asks, Allow and Deny only', r.cards.length === 1 && r.card.browser.card === 'eval' && r.card.alwaysLabel === '' && r.card.projectLabel === '', r.card);
  check('4: … its detail is the action, the reason, and the code after a blank line', r.card.detail === 'Run JavaScript on example.com\nTo check the title.\n\ndocument.title', r.card.detail);
  check('4: … and it ran once allowed', r.result === '<page_content site="example.com">"Page"</page_content>' && page.evals.at(-1) === 'document.title');
  r = await step('browser_eval', { code: 'document.title' }, [SESSION]);
  check('4: "for this session" on an eval card is "once": the next eval asks again', r.resolved[0].scope === 'once' && r.result === '<page_content site="example.com">"Page"</page_content>');
  r = await step('browser_eval', { code: 'document.title' }, [DENY]);
  check('4: … and so it does', r.cards.length === 1 && r.result === DENIED);
  mode('auto');
  const evals = page.evals.length;
  r = await step('browser_eval', { code: 'document.cookie' }, [DENY]);
  check('4: auto mode: document.cookie asks, with the guard\'s reason', r.cards.length === 1 && r.card.browser.card === 'eval' && r.card.reason === "reads the site's cookies or storage" && r.result === DENIED && page.evals.length === evals, r.card);
  r = await step('browser_eval', { code: 'document.title' });
  check('4: auto mode: document.title runs without a card', r.cards.length === 0 && r.result === '<page_content site="example.com">"Page"</page_content>');
  page.url = 'https://brand-new.example/';
  r = await step('browser_eval', { code: 'document.title' }, [DENY]);
  check('4: auto mode: a new site still asks first, with the site card', r.cards.length === 1 && r.card.browser.card === 'site');

  // ---------- 5. Plan mode ----------
  mode('plan');
  state.requests.length = 0;
  page.url = 'https://plan.example/';
  r = await step('browser_read_page', {}, [DENY]);
  const offered = (state.requests.find((q) => q.url === '/v1/chat/completions' && q.payload.stream)?.payload.tools ?? []).map((t) => t.function.name);
  check('5: plan mode offers the reading browser tools only', offered.includes('browser_read_page') && offered.includes('browser_navigate') && offered.includes('browser_tabs') && !offered.includes('browser_click') && !offered.includes('browser_type') && !offered.includes('browser_press_key') && !offered.includes('browser_eval'), offered.filter((x) => x.startsWith('browser_')));
  check('5: … allTools("plan") agrees', allTools('plan').filter((t) => t.name.startsWith('browser_')).map((t) => t.name).sort().join() === 'browser_find,browser_get_text,browser_navigate,browser_read_page,browser_screenshot,browser_scroll,browser_tabs,browser_wait_for');
  check('5: a read on a new site asks with the site card', r.cards.length === 1 && r.card.browser.card === 'site' && r.card.mode === 'plan');
  page.targets = { Submit: {} };
  r = await step('browser_click', { text: 'Submit' });
  check('5: browser_click is refused (not offered), nothing clicked', r.cards.length === 0 && /^(Error: unknown tool|Not permitted)/.test(r.result ?? '') && !page.clicked.includes('Submit'), r.result);
  r = await step('browser_tabs', { action: 'new', url: 'https://plan-tab.example/' }, [DENY]);
  check('5: browser_tabs new is a navigation, with the site card', r.cards.length === 1 && r.card.browser.site === 'plan-tab.example');

  // ---------- 6. Bypass: nothing asks, but a purchase does ----------
  mode('bypass');
  page.url = 'https://shop.example/cart';
  page.targets = { 'Pay now': {}, 'Create account': {}, 'Sign in': { role: 'link', tag: 'a' }, Continue: { formHasCardFields: true }, 'Not a robot': { inCaptcha: true, role: 'checkbox', tag: 'span' } };
  r = await step('browser_read_page', {});
  check('6: bypass: a new site reads without a card', r.cards.length === 0 && /^<page_content site="[^"]+">URL:/.test(r.result ?? ''));
  r = await step('browser_click', { text: 'Sign in' });
  check('6: … an ordinary click runs', r.cards.length === 0 && page.clicked.at(-1) === 'Sign in');
  r = await step('browser_click', { text: 'Pay now', reason: 'The user asked me to check out.' }, [DENY]);
  check('6: a "Pay now" click still asks, with the purchase card', r.cards.length === 1 && r.card.browser.card === 'purchase' && r.card.browser.site === 'shop.example' && r.card.mode === 'bypass', r.card);
  check('6: … Allow and Deny only, saying why', r.card.alwaysLabel === '' && r.card.projectLabel === '' && r.card.reason === '"Pay now" looks like a purchase' && r.card.detail === 'Click "Pay now" on shop.example\nThe user asked me to check out.', r.card);
  check('6: … denied: DENIED, nothing clicked', r.result === DENIED && !page.clicked.includes('Pay now'));
  r = await step('browser_click', { text: 'Pay now' }, [[true, true, 'project']]);
  check('6: … allowed: clicked, and no rule or site saved from it', page.clicked.at(-1) === 'Pay now' && r.resolved[0].scope === 'once' && !app.config().browser.alwaysAllowed.includes('shop.example'));
  r = await step('browser_click', { text: 'Continue' }, [DENY]);
  check('6: a submit in a form with card fields asks as a purchase', r.cards.length === 1 && r.card.browser.card === 'purchase' && r.card.reason === 'The form holds card fields');
  r = await step('browser_click', { text: 'Create account' }, [DENY]);
  check('6: "Create account" asks with the account card', r.cards.length === 1 && r.card.browser.card === 'account' && r.card.reason === '"Create account" looks like account creation' && r.result === DENIED);
  r = await step('browser_click', { text: 'Not a robot' });
  check('6: a click on a CAPTCHA widget is refused, no card', r.cards.length === 0 && /^Not permitted: CAPTCHAs are for the user to solve/.test(r.result ?? '') && !page.clicked.includes('Not a robot'), r.result);
  page.atPoint = { text: '', role: '', tag: 'iframe', type: '', inCaptcha: true, formHasCardFields: false, formActionHost: null };
  r = await step('browser_click', { x: 40, y: 300 });
  check('6: … also at a point over a CAPTCHA frame', /^Not permitted: CAPTCHAs/.test(r.result ?? '') && !page.clicked.includes('(40, 300)'), r.result);
  page.atPoint = null;
  page.url = 'http://localhost:3000/checkout';
  r = await step('browser_click', { text: 'Pay now' });
  check('6: on an exempt host (the user\'s own app) a purchase click needs no card', r.cards.length === 0 && page.clicked.at(-1) === 'Pay now');

  // ---------- 7. Typing and keys into credential fields ----------
  page.fieldKinds = { Password: 'password', Email: null, 'Card number': 'card' };
  page.url = 'https://example.com/login';
  const typed = page.typed.length;
  r = await step('browser_type', { field: 'Password', text: 'hunter2-Secret' });
  check('7: browser_type into a password field on a site is refused', r.result === CREDENTIAL_REFUSAL && r.cards.length === 0, r.result);
  check('7: … before anything is typed', page.typed.length === typed);
  check('7: … and the text is hidden in the stored call either way', r.stored && r.stored.text === MASK && !JSON.stringify(rt.get(sid).messages).includes('hunter2-Secret'), r.stored);
  mode('ask');
  r = await step('browser_type', { field: 'Card number', text: '4242424242424242' });
  check('7: … in ask mode too, and a card field as well, with no card first', r.result === CREDENTIAL_REFUSAL && r.cards.length === 0 && page.typed.length === typed);
  mode('bypass');
  r = await step('browser_type', { field: 'Email', text: 'ada@example.com' });
  check('7: an ordinary field takes the text', page.typed.at(-1) === 'ada@example.com' && /^Typed "ada@example\.com"/.test(r.result ?? ''), r.result);
  page.url = 'http://localhost:3000/login';
  r = await step('browser_type', { field: 'Password', text: 'local-Test-pw' });
  check('7: on http://localhost:3000 it types, the text hidden', page.typed.at(-1) === 'local-Test-pw' && /^Typed 13 characters into a password field/.test(r.result ?? '') && !r.result.includes('local-Test-pw') && r.stored.text === MASK, { result: r.result, stored: r.stored });
  page.url = 'https://example.com/login';
  page.focusedKind = 'password';
  r = await step('browser_press_key', { key: 'a' });
  check('7: browser_press_key "a" into a focused password field is refused', r.result === CREDENTIAL_REFUSAL && !page.keys.includes('a'), r.result);
  r = await step('browser_press_key', { key: 'Enter' });
  check('7: … Enter is not', r.result === 'Pressed Enter.' && page.keys.at(-1) === 'Enter', r.result);
  page.focusedKind = null;
  r = await step('browser_press_key', { key: 'a' });
  check('7: … and "a" into an ordinary field goes through', r.result === 'Pressed a.');

  // ---------- 8. Sensitive sites and the sign-in page signal ----------
  mode('ask');
  page.url = 'https://accounts.google.com/signin';
  page.targets = { Next: { role: '', tag: 'button', type: 'button' } };
  r = await step('browser_read_page', {}, [SESSION]);
  check('8: an identity provider\'s site card carries the amber note from the start', r.cards.length === 1 && r.card.browser.card === 'site' && r.card.note === 'This looks like a sign-in site', r.card);
  r = await step('browser_click', { text: 'Next' }, [ONCE]);
  check('8: an act there asks with the sensitive card and the amber note in the event', r.cards.length === 1 && r.card.browser.card === 'sensitive' && r.card.note === 'This looks like a sign-in site' && r.card.alwaysLabel === '' && r.card.detail === 'Click "Next" on accounts.google.com', r.card);
  check('8: … allowed once, it clicked', page.clicked.at(-1) === 'Next' && r.resolved[0].scope === 'once');
  r = await step('browser_click', { text: 'Next' }, [DENY]);
  check('8: … and asks for every act there', r.cards.length === 1 && r.card.browser.card === 'sensitive');
  r = await step('browser_read_page', {});
  check('8: a read there does not', r.cards.length === 0);
  page.url = 'https://example.com/login';
  page.passwordField = true;
  page.targets = { 'Sign in': {} };
  r = await step('browser_click', { text: 'Sign in' }, [ONCE]);
  check('8: an ordinary site\'s page with a password field asks before the first act', r.cards.length === 1 && r.card.browser.card === 'sensitive' && r.card.note === 'This looks like a sign-in page', r.card);
  r = await step('browser_click', { text: 'Sign in' });
  check('8: … once: allowed, that page asks no more this session', r.cards.length === 0 && page.clicked.at(-1) === 'Sign in');
  page.url = 'https://example.com/login?next=/b';
  r = await step('browser_click', { text: 'Sign in' });
  check('8: … the same page with another query neither', r.cards.length === 0);
  page.url = 'https://example.com/signup';
  r = await step('browser_click', { text: 'Sign in' }, [DENY]);
  check('8: another page with a password field asks', r.cards.length === 1 && r.card.browser.card === 'sensitive');
  page.passwordField = false;

  // ---------- 9. The rules and the labels ----------
  const site = siteOf('https://example.com/');
  const ctx = { mode: 'plan', cwd: project, rules: undefined, mcp: () => undefined, allowed: { mcp: () => false, reason: () => false, program: () => false } };
  const decide = (card, m) => decideApproval('browser_click', 'x', undefined, { browser: { site, card } }, { ...ctx, mode: m });
  check('9: decideApproval: a browser card asks in every mode it reaches, plan and bypass included', ['ask', 'acceptEdits', 'auto', 'plan', 'bypass'].every((m) => decide('purchase', m).kind === 'ask' && decide('site', m).kind === 'ask'));
  check('9: … only the site card has the wider answers', decide('site', 'ask').custom === false && ['sensitive', 'eval', 'purchase', 'account'].every((c) => decide(c, 'ask').custom === true));
  const labels = approvalLabels('browser_read_page', null, [], site);
  check('9: approvalLabels for a site', labels.alwaysLabel === 'Allow example.com for this session' && labels.projectLabel === 'Always allow example.com', labels);
  const src = fs.readFileSync(path.join(projectDir, 'dist/renderer/tool-labels.js'), 'utf8');
  const L = await import('data:text/javascript,' + encodeURIComponent(src));
  const title = (card, s = 'example.com') => L.browserApproval({ card, site: s }).title;
  check('9: the card titles', title('site') === 'Let the agent use example.com?' && title('sensitive') === 'Act on a sensitive site?' && title('eval') === 'Run JavaScript on example.com?' && title('purchase') === 'Make a purchase?' && title('account') === 'Create an account?', ['site', 'sensitive', 'eval', 'purchase', 'account'].map((c) => title(c)));
  check('9: the decided line names the site', L.browserDecision({ card: 'site', site: 'example.com' }, true, 'once') === 'Allowed once on example.com' && L.browserDecision({ card: 'site', site: 'example.com' }, true, 'session') === 'Allowed example.com for this session' && L.browserDecision({ card: 'site', site: 'example.com' }, true, 'project') === 'Always allowed example.com' && L.browserDecision({ card: 'purchase', site: 'shop.example' }, false, 'once') === 'Denied on shop.example');
  check('9: … and the subject of a decided card without a row', L.browserApproval({ card: 'site', site: 'example.com' }).subject === 'example.com' && L.browserApproval({ card: 'purchase', site: 'shop.example' }).subject === 'a purchase on shop.example' && L.browserApproval({ card: 'site', site: '' }).title === 'Let the agent use this page?');
  check('9: a local file\'s card asks to read it, its path under the title', title('site', '~/notes/a.html') === 'Let the agent read a local file?' && title('site', '/etc/hosts') === 'Let the agent read a local file?' && L.browserApproval({ card: 'site', site: '~/notes/a.html' }).subject === '~/notes/a.html');
  // Changed on purpose: the browser is a tool group now; its rules come with its load (the load_tools result in the
  // conversation), not in the system prompt, which stays the same as groups load
  const prompt = (state.requests.filter((q) => q.url === '/v1/chat/completions' && q.payload.stream).pop()?.payload.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  check('9: the model is told about approvals, reason, credentials and purchases', /Each site needs the user's approval before you read or act on it; say why in reason/.test(prompt) && /Never type a password, a one-time code or card details/.test(prompt) && /Purchases and new accounts are the user's to approve/.test(prompt));
  const specs = Object.fromEntries(allTools('ask').filter((t) => t.name.startsWith('browser_')).map((t) => [t.name, t.parameters.properties]));
  check('9: reason is a parameter of the six tools that may ask, not of the readers', ['browser_navigate', 'browser_tabs', 'browser_click', 'browser_type', 'browser_press_key', 'browser_eval'].every((n) => specs[n].reason?.type === 'string') && ['browser_read_page', 'browser_get_text', 'browser_find', 'browser_wait_for', 'browser_scroll', 'browser_screenshot'].every((n) => !specs[n].reason));

  // ---------- 10. PreToolUse hooks: allow skips the site card (not a purchase), ask forces one ----------
  {
    const store = new SessionStore(path.join(tmp, 'hook-sessions'));
    const artifacts = new ArtifactStore({ root: path.join(tmp, 'hook-artifacts'), rendererDir: path.join(projectDir, 'dist/renderer') });
    const cmd = (decision) => ({ type: 'command', command: `printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"${decision}"}}'` });
    let groups = [];
    const engine = new HookEngine({ settings: () => ({ sets: [{ groups, source: 'user', label: 'settings.json' }], disabled: false }) });
    const hookEvents = [];
    let answers = [];
    let agent;
    const emit = (ev) => {
      hookEvents.push(ev);
      if (ev.type === 'approval_request') {
        const a = answers.length ? answers.shift() : false;
        setTimeout(() => agent.resolveApproval(ev.id, a), 5);
      }
    };
    const hookConfig = { ...config, permissionMode: 'ask', browser: { keepCookies: true, downloadsDir: '', openChatLinksInPane: false, alwaysAllowed: [], sensitive: [], exempt: [] } };
    agent = new Agent(() => hookConfig, browser, store, () => [], emit, undefined, artifacts, undefined, { hooks: engine });
    const run = async (name, args) => {
      const id = `hook_${++n}`;
      hookEvents.length = 0;
      state.replies.push({ content: '', toolCalls: [{ id, name, args }] });
      state.replies.push({ content: 'ok' });
      await agent.run('go');
      return { cards: hookEvents.filter((e) => e.type === 'approval_request'), result: hookEvents.find((e) => e.type === 'tool_end' && e.id === id)?.result };
    };
    page.url = 'https://hooked.example/';
    page.targets = { 'Pay now': {} };
    groups = [{ event: 'PreToolUse', matcher: 'browser_read_page|browser_click', handlers: [cmd('allow')] }];
    let h = await run('browser_read_page', {});
    check('10: a PreToolUse allow skips the site card', h.cards.length === 0 && /^<page_content site="hooked\.example">URL: https:\/\/hooked\.example\//.test(h.result ?? ''), h);
    const clicks = page.clicked.length;
    h = await run('browser_click', { text: 'Pay now' });
    check('10: … but not a purchase card, which bypass shows too', h.cards.length === 1 && h.cards[0].browser?.card === 'purchase' && h.result === DENIED && page.clicked.length === clicks, h.cards.map((c) => c.browser));
    groups = [{ event: 'PreToolUse', matcher: 'browser_get_text', handlers: [cmd('ask')] }];
    answers = [true];
    h = await run('browser_get_text', {});
    check('10: a PreToolUse ask forces a card; once answered, the site card is not shown on top', h.cards.length === 1 && !h.cards[0].browser && /Some text/.test(h.result ?? ''), h.cards);
    groups = [];
    h = await run('browser_get_text', {});
    check('10: without the hook the site still asks (the hook allowed nothing for later)', h.cards.length === 1 && h.cards[0].browser?.card === 'site');
    const seen = path.join(tmp, 'post-tool-use.json');
    const denied = path.join(tmp, 'post-tool-use-failure.json');
    groups = [
      { event: 'PreToolUse', matcher: 'browser_read_page', handlers: [cmd('allow')] },
      { event: 'PostToolUse', matcher: 'browser_read_page', handlers: [{ type: 'command', command: `cat > '${seen}'` }] },
      { event: 'PostToolUseFailure', matcher: 'browser_get_text', handlers: [{ type: 'command', command: `cat > '${denied}'` }] },
    ];
    await run('browser_read_page', {});
    await run('browser_get_text', {});
    const post = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, 'utf8')) : null;
    const failure = fs.existsSync(denied) ? JSON.parse(fs.readFileSync(denied, 'utf8')) : null;
    check('10: PostToolUse sees the result of a call the site check let through', post && post.tool_name === 'browser_read_page' && /^<page_content site="hooked\.example">URL: https:\/\/hooked\.example\//.test(post.tool_response), post);
    check('10: … and PostToolUseFailure the denial of one it stopped', failure && failure.tool_name === 'browser_get_text' && failure.error === DENIED, failure);
  }

  mock.close();
  rt.stopAll();
  done();
})().catch((err) => {
  console.error('CRASH', err);
  process.exit(1);
});
