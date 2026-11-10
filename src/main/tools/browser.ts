import { resolveTarget } from '../browser/controller';
import {
  actionLine,
  actionOf,
  clickRule,
  clipboardRule,
  CREDENTIAL_REFUSAL,
  isExempt,
  isSensitive,
  keyRule,
  navigationRule,
  ownServerRule,
  signInPageKey,
  siteDecision,
  siteOf,
  typeRule,
  typesACharacter,
  type BrowserCard,
  type ClickTarget,
  type Site,
} from '../browser/policy';
import { fencePage } from '../browser/fence';
import { localAddresses, ownPorts } from '../browser/own-ports';
import { looksLikeCredentialLabel, MASK, scrubSecrets, type CredentialKind } from '../browser/safety';
import type { Tool, ToolContext, ToolResult } from './types';

/** The values of the page's filled credential fields; none when the page (or a test's stand-in) cannot say. */
async function secrets(ctx: ToolContext): Promise<string[]> {
  try {
    return await ctx.browser.secretValues();
  } catch {
    return [];
  }
}

// ---------- The site check (policy.ts decides; the card is the agent's approval card) ----------

/** Asks the page something; `fallback` when it cannot say (a closed tab, or a test's stand-in without that method). */
async function askPage<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return (await fn()) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The page the active tab shows ('' when the browser cannot say). */
function activeUrl(ctx: ToolContext): string {
  try {
    return String(ctx.browser.state().url ?? '');
  } catch {
    return '';
  }
}

/** The user's lists from Settings → Browser. */
function lists(ctx: ToolContext): { exempt: string[]; alwaysAllowed: string[]; sensitive: string[] } {
  const b = ctx.config?.browser;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return { exempt: arr(b?.exempt), alwaysAllowed: arr(b?.alwaysAllowed), sensitive: arr(b?.sensitive) };
}

/** The card's name for a page with no site (about:blank): a purchase card there still says where. */
const NO_SITE: Site = { key: '', display: 'this page', scheme: '', host: '', port: '', path: '' };

/** browser_eval's code on its card: as much as the user can read before deciding. */
const MAX_CARD_CODE = 4000;

/**
 * What the card shows below its title: the action ("Click "Pay now" on shop.example"), then the model's reason on a
 * line of its own (one line, clipped), then for browser_eval a blank line and the code. The reason goes nowhere else.
 */
function cardDetail(line: string, args: Record<string, unknown>, code?: string): string {
  const why = typeof args?.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim() : '';
  const reason = why.length > 300 ? `${why.slice(0, 299)}…` : why;
  const shown = code && code.length > MAX_CARD_CODE ? `${code.slice(0, MAX_CARD_CODE - 1)}…` : code;
  return `${line}${reason ? `\n${reason}` : ''}${shown ? `\n\n${shown}` : ''}`;
}

/** Shows a browser card and waits: null when allowed, else the message the model reads (DENIED). */
async function askCard(ctx: ToolContext, name: string, detail: string, card: BrowserCard, site: Site, extra: { note?: string; reason?: string; page?: string } = {}): Promise<string | null> {
  const r = await ctx.approve(name, detail, undefined, { browser: { site, card, ...extra } });
  return r.ok ? null : r.message;
}

/**
 * Before typing or a key press, without changing the page: a password, one-time code or card field (by the page's
 * word, or a field named like one) on a site that is not exempt is refused, so nothing reaches it and the site card is
 * not asked for in vain. On exempt hosts the text goes in, hidden as before.
 */
async function credentialCheck(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> {
  if (name !== 'browser_type' && name !== 'browser_press_key') return null;
  if (isExempt(activeUrl(ctx), lists(ctx).exempt, ctx.cwd)) return null;
  if (name === 'browser_press_key') {
    const combo = String(args.key ?? '');
    const clip = clipboardRule(combo, false);
    if (clip.kind === 'refuse') return clip.message;
    // Enter, Tab, the arrows and shortcuts go through whatever has the focus: the page is asked only for a character
    if (!typesACharacter(combo)) return null;
    const focused = (await askPage(() => ctx.browser.credentialTarget(), null)) as CredentialKind | 'embedded' | null;
    const rule = keyRule(combo, focused, false);
    return rule.kind === 'refuse' ? rule.message : null;
  }
  const field = typeof args.field === 'string' ? args.field : undefined;
  const kind = ((await askPage(() => ctx.browser.credentialTarget(args.ref ? String(args.ref) : undefined, field), null)) ?? (field && looksLikeCredentialLabel(field) ? 'password' : null)) as CredentialKind | 'embedded' | null;
  const rule = typeRule(kind, false);
  return rule.kind === 'refuse' ? rule.message : null;
}

/**
 * The site check every browser tool call passes before it runs. The page it concerns is where a navigation goes
 * (browser_navigate, browser_tabs new; "back" and "forward" stay on the active page, which the next call checks once
 * it has landed) and the active tab's page for everything else. A navigation the policy refuses (javascript:, data:,
 * a scheme of the browser's own) never asks; a local file outside the project asks with its path. Then siteDecision:
 * run, refuse, or a card (the site's first approval, an act on a sensitive or sign-in page, a browser_eval). null:
 * go on; otherwise the message the model reads.
 */
async function siteCheck(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string | null> {
  // Listing, switching and closing tabs read nothing of a page: the next call on the tab in front is checked as usual.
  if (name === 'browser_tabs' && args.action !== 'new') return null;
  const action = actionOf(name, args);
  const settings = lists(ctx);
  let url = activeUrl(ctx);
  let line: string | undefined;
  const raw = typeof args.url === 'string' ? args.url.trim() : '';
  const opensTab = name === 'browser_tabs' && args.action === 'new';
  if (opensTab || (name === 'browser_navigate' && raw !== 'back' && raw !== 'forward')) {
    // Where it goes, resolved as the controller resolves it (a new tab starts from nothing)
    const dest = opensTab ? (raw ? resolveTarget(raw, '') : 'about:blank') : resolveTarget(raw, url);
    const nav = navigationRule(dest, ctx.cwd, settings.exempt);
    if (nav.kind === 'refuse') return nav.message;
    url = dest;
    if (nav.kind === 'ask') line = opensTab ? `${nav.detail}, in a new tab` : nav.detail;
  }
  // The app's own remote-control and debugging servers are never the agent's, whatever the mode or the exemption
  const own = ownServerRule(url, ownPorts(), localAddresses());
  if (own.kind === 'refuse') return own.message;
  const page = signInPageKey(url);
  // The sign-in page signal, asked for an act until the user allowed one on that page
  const signIn = action === 'act' && page !== null && ctx.mode !== 'bypass' && !ctx.signInPagesAllowed?.().has(page) && !isExempt(url, settings.exempt, ctx.cwd);
  const pageHasPasswordField = signIn ? await askPage(() => ctx.browser.pageHasPasswordField(), false) : false;
  const code = name === 'browser_eval' ? String(args.code ?? '') : undefined;
  // A blank or data: page a page made is that page's site (its committed origin)
  const origin = !siteOf(url) && action !== 'navigate' ? await askPage(async () => ctx.browser.pageOrigin(), '') : '';
  const decision = siteDecision({ url, action, mode: ctx.mode, cwd: ctx.cwd, settings, sessionAllowed: ctx.sitesAllowed?.() ?? new Set(), pageHasPasswordField, evalCode: code, origin });
  if (decision.kind === 'allow') return null;
  if (decision.kind === 'refuse') return decision.message;
  const detail = cardDetail(line ?? actionLine(name, args, decision.site), args, code);
  return askCard(ctx, name, detail, decision.card, decision.site, { note: decision.note, reason: decision.reason, page: decision.card === 'sensitive' ? page ?? undefined : undefined });
}

/**
 * browser_click, once the element is known: a click inside a CAPTCHA is refused; one that buys something or makes an
 * account asks with a card of its own (Allow and Deny, in every mode, Bypass included), except on an exempt host,
 * which is the user's own app under development. What decides is what is really under the click point (hit-tested in
 * the safety world): a ref covered by something else, or changed since the outline, is refused; a click that lands in
 * a frame from another site asks with that site named (in every mode), and is refused when that site is a sensitive
 * one. `target` is what the rules saw, which the click checks again at the moment it clicks.
 */
async function clickCheck(args: Record<string, unknown>, ctx: ToolContext, at: { ref: string } | { x: number; y: number }): Promise<{ stop: string | null; target: ClickTarget | null }> {
  const target = await askPage<ClickTarget | null>(() => ctx.browser.describeTarget(at), null);
  if (!target) return { stop: null, target: null };
  const rule = clickRule(target);
  if (rule.kind === 'refuse') return { stop: rule.message, target };
  const url = activeUrl(ctx);
  const exempt = isExempt(url, lists(ctx).exempt, ctx.cwd);
  const site = siteOf(url);
  if (target.frameOrigin && !exempt) {
    const frame = siteOf(target.frameOrigin);
    const name = frame?.display ?? target.frameOrigin;
    const sensitive = isSensitive(target.frameOrigin, lists(ctx).sensitive);
    if (sensitive.sensitive) return { stop: `Not permitted: this click lands in a frame from ${name} (${sensitive.note.replace(/^This/, 'this')}). Ask the user to click it in the Browser pane.`, target };
    const stop = await askCard(ctx, 'browser_click', cardDetail(`Click inside a frame from ${name} on ${(site ?? NO_SITE).display}`, args), 'sensitive', frame ?? site ?? NO_SITE, { note: `This click goes into a frame from ${name}, another site` });
    if (stop) return { stop, target };
  }
  if (rule.kind === 'allow' || exempt) return { stop: null, target };
  return { stop: await askCard(ctx, 'browser_click', cardDetail(actionLine('browser_click', args, site), args), rule.what, site ?? NO_SITE, { reason: rule.detail }), target };
}

/** The optional `reason` of the tools that may need the user's approval: shown on the card, under the action. */
const REASON = { reason: { type: 'string', description: 'Why, in one sentence (shown if approval is needed)' } };

/** The tools that return what a page says, which must come from the page that was checked. */
const READS = new Set(['browser_get_text', 'browser_read_page', 'browser_find', 'browser_wait_for']);

/** The active tab and its page's site key ('' when the browser cannot say). */
function pageNow(ctx: ToolContext): { tabId: string; url: string; key: string } {
  try {
    const s = ctx.browser.state();
    const url = String(s.url ?? '');
    return { tabId: String(s.activeId ?? ''), url, key: siteOf(url)?.key ?? url };
  } catch {
    return { tabId: '', url: '', key: '' };
  }
}

/**
 * The refusal when the page moved between the site check (and its card) and the action or the read: another tab in
 * front, or (`sameSite`) another site in the tab. null: the same page.
 */
function pageChanged(checked: { tabId: string; key: string }, now: { tabId: string; url: string; key: string }, sameSite: boolean): string | null {
  const where = siteOf(now.url)?.display ?? (now.url || 'a blank page');
  if (checked.tabId !== now.tabId) return `The active tab changed to ${now.tabId} (${where}); call again.`;
  if (sameSite && checked.key !== now.key) return `The page changed to ${where}; call again.`;
  return null;
}

/** The tools whose whole result is the page's text (the others fence the page's words inside their own sentence). */
const PAGE_RESULTS = new Set(['browser_get_text', 'browser_read_page', 'browser_find', 'browser_eval']);

/**
 * Every browser tool's call passes the credential and site checks first (a refusal or a denial is its result), and
 * its result and error pass through here: the values of the page's credential fields, read before and after the
 * call (browser_eval may change or clear them), come out as •••, whatever the call returned.
 */
function guarded(tool: Tool): Tool {
  const run = tool.run;
  return {
    ...tool,
    group: 'browser',
    run: async (args, ctx): Promise<ToolResult> => {
      const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      // The page the check is about: the call acts on that one, and reads from it, or not at all
      const checked = pageNow(ctx);
      const stop = (await credentialCheck(tool.name, a, ctx)) ?? (await siteCheck(tool.name, a, ctx));
      if (stop) return { content: stop };
      const tabsOnly = tool.name === 'browser_tabs' && a.action !== 'new';
      const opens = tool.name === 'browser_navigate' || tool.name === 'browser_tabs';
      const moved = tabsOnly ? null : pageChanged(checked, pageNow(ctx), !opens);
      if (moved) return { content: moved };
      const before = await secrets(ctx);
      try {
        const r = await run(args, ctx);
        const content = scrubSecrets(r.content, [...before, ...(await secrets(ctx))]);
        // A read that came back from another page than the one checked (a redirect, another tab in front) is not returned
        const after = READS.has(tool.name) ? pageChanged(checked, pageNow(ctx), true) : null;
        if (after) return { content: after };
        // What the page says is data from the site: fenced, the site named by the browser
        return { ...r, content: PAGE_RESULTS.has(tool.name) ? fencePage(activeUrl(ctx), content) : content };
      } catch (err) {
        throw new Error(scrubSecrets(err instanceof Error ? err.message : String(err), [...before, ...(await secrets(ctx))]));
      }
    },
  };
}

/** One line per tab for browser_tabs list: the active one marked. */
function tabLines(tabs: { id: string; title: string; url: string; loading: boolean }[], activeId: string): string {
  return tabs
    .map((t) => `${t.id === activeId ? '*' : ' '} ${t.id}  ${t.title ? `"${t.title}"  ` : ''}${t.url || 'about:blank'}${t.loading ? '  (loading)' : ''}${t.id === activeId ? '  (active)' : ''}`)
    .join('\n');
}

const tools: Tool[] = [
  {
    name: 'browser_tabs',
    description:
      'The browser pane\'s tabs: list; new (opens url, or a blank tab; background=true leaves the current tab in front); select (tab_id); close (tab_id, default the active tab). Every other browser_* tool acts on the active tab.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        url: { type: 'string', description: 'For new: the URL or search to open' },
        tab_id: { type: 'string', description: 'For select and close, e.g. tab-2' },
        background: { type: 'boolean', description: 'For new: do not switch to the tab' },
        ...REASON,
      },
      required: ['action'],
    },
    readOnly: true,
    run: async (args, ctx) => {
      const b = ctx.browser;
      const action = String(args.action ?? 'list');
      const list = () => {
        const s = b.state();
        return `${s.tabs.length} tab${s.tabs.length === 1 ? '' : 's'}:\n${tabLines(s.tabs, s.activeId)}`;
      };
      if (action === 'list') return { content: list() };
      if (action === 'new') {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        if (!url) {
          const t = b.newTab(undefined, { background: Boolean(args.background) });
          return { content: `Opened ${t.id}, a blank tab${args.background ? ', in the background' : ''}.` };
        }
        return { content: await b.openTab(url, { background: Boolean(args.background) }) };
      }
      if (action === 'select') {
        if (!args.tab_id) throw new Error('select needs tab_id (see list).');
        b.activate(String(args.tab_id));
        const s = b.state();
        return { content: `Now on ${s.activeId}: ${fencePage(s.url, `${s.url}${s.title ? ` — "${s.title}"` : ''}`)}` };
      }
      if (action === 'close') {
        const id = args.tab_id ? String(args.tab_id) : b.state().activeId;
        b.closeTab(id);
        return { content: `Closed ${id}.\n${list()}` };
      }
      throw new Error(`Unknown action "${action}": use list, new, select or close.`);
    },
  },
  {
    name: 'browser_navigate',
    description: 'Open a URL in the built-in browser pane and wait for it to load. Also accepts "back", "forward", or a path relative to the current page (e.g. "form.html"). A bare search phrase is sent to DuckDuckGo.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL, "back", "forward", or search terms' }, ...REASON }, required: ['url'] },
    run: async (args, ctx) => ({ content: await ctx.browser.navigate(String(args.url)) }),
  },
  {
    name: 'browser_get_text',
    description: 'Return the visible text of the current page (main content first). Best for reading articles and docs.',
    parameters: { type: 'object', properties: { max_chars: { type: 'integer', description: 'Maximum characters to return (default 50000)' } } },
    run: async (args, ctx) => ({ content: await ctx.browser.getText(Number(args.max_chars) || 50_000) }),
  },
  {
    name: 'browser_read_page',
    description:
      'Outline the current page as a list of visible interactive elements, each tagged with a ref id like [ref_3] that browser_click and browser_type accept. filter="all" also includes headings and text. Password, one-time code and card fields never show their value: a filled one reads = "•••", an empty one (empty).',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['interactive', 'all'], description: 'interactive (default) or all' },
        max_chars: { type: 'integer', description: 'Maximum characters to return (default 40000)' },
      },
    },
    run: async (args, ctx) => ({
      content: await ctx.browser.readPage(args.filter === 'all' ? 'all' : 'interactive', Number(args.max_chars) || 40_000),
    }),
  },
  {
    name: 'browser_find',
    description: 'Search the current page for elements or text containing a phrase (case-insensitive). Returns matching outline lines with refs.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Text to look for, e.g. "Sign in"' } }, required: ['query'] },
    run: async (args, ctx) => ({ content: await ctx.browser.find(String(args.query)) }),
  },
  {
    name: 'browser_click',
    description: 'Click an element by its visible text (e.g. "Sign in"), by its ref from browser_read_page, or at viewport coordinates.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text or label of the element to click (simplest option)' },
        ref: { type: 'string', description: 'Element ref such as ref_3' },
        x: { type: 'number', description: 'Viewport x in CSS pixels (when no ref)' },
        y: { type: 'number', description: 'Viewport y in CSS pixels (when no ref)' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        double: { type: 'boolean', description: 'Double-click' },
        ...REASON,
      },
    },
    run: async (args, ctx) => {
      const button = (['left', 'right', 'middle'].includes(args.button) ? args.button : 'left') as 'left' | 'right' | 'middle';
      const ref = args.ref ? String(args.ref) : args.text ? await ctx.browser.findRef(String(args.text), 'any') : '';
      const point = !ref && typeof args.x === 'number' && typeof args.y === 'number' ? { x: args.x, y: args.y } : null;
      if (!ref && !point) throw new Error('Provide text, a ref, or x and y.');
      // What the click lands on decides first: a CAPTCHA is refused, a purchase or a new account asks.
      const { stop, target } = await clickCheck(args, ctx, ref ? { ref } : point!);
      if (stop) return { content: stop };
      if (ref) return { content: await ctx.browser.click(ref, button, Boolean(args.double), target) };
      return { content: await ctx.browser.clickPoint(point!.x, point!.y, button, args.double ? 2 : 1, target) };
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into a field chosen by its label or placeholder (field), by ref, or into whatever currently has focus. Replaces existing content unless clear=false. Set submit=true to press Enter afterwards. Password, one-time code and card fields are refused, except on local development hosts, where the text is typed but never repeated.',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', description: 'Label or placeholder of the field to type into (simplest option)' },
        ref: { type: 'string', description: 'Element ref such as ref_5' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        clear: { type: 'boolean', description: 'Clear the field first (default true)' },
        ...REASON,
      },
      required: ['text'],
    },
    // The text to type into a credential field stays out of the transcript, the tool row and hooks from the start.
    shownArgs: async (args, ctx) => {
      if (typeof args?.text !== 'string' || !args.text) return null;
      const hidden = { ...args, text: MASK };
      if (typeof args.field === 'string' && looksLikeCredentialLabel(args.field)) return hidden;
      if (!ctx.foreground()) return null;
      const kind = await ctx.browser.credentialTarget(args.ref ? String(args.ref) : undefined, args.field ? String(args.field) : undefined).catch(() => null);
      return kind ? hidden : null;
    },
    run: async (args, ctx) => {
      const ref = args.ref ? String(args.ref) : args.field ? await ctx.browser.findRef(String(args.field), 'field') : undefined;
      // The controller asks the page again after its own click (a click can move the focus into a password field)
      const allowSecret = isExempt(activeUrl(ctx), lists(ctx).exempt, ctx.cwd);
      try {
        const r = await ctx.browser.type(ref, String(args.text), Boolean(args.submit), args.clear !== false, { allowSecret });
        return r.secret ? { content: r.content, hiddenArgs: { ...args, text: MASK } } : { content: r.content };
      } catch (err) {
        // Nothing was typed; the text was meant for a credential field after all, so the stored call hides it too
        if (err instanceof Error && err.message === CREDENTIAL_REFUSAL) return { content: CREDENTIAL_REFUSAL, hiddenArgs: { ...args, text: MASK } };
        throw err;
      }
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until the page shows some text or an element matching a CSS selector (default timeout 10 s). Use after clicks that load or update content.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text that must appear on the page (case-insensitive)' },
        selector: { type: 'string', description: 'CSS selector that must match an element' },
        timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds (default 10000, max 60000)' },
      },
    },
    run: async (args, ctx) => ({
      content: await ctx.browser.waitFor(args.text ? String(args.text) : undefined, args.selector ? String(args.selector) : undefined, Number(args.timeout_ms) || 10_000),
    }),
  },
  {
    name: 'browser_press_key',
    description: 'Press a key or shortcut in the page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "cmd+a". Paste, copy and cut are refused: the clipboard is the user\'s.',
    parameters: { type: 'object', properties: { key: { type: 'string' }, ...REASON }, required: ['key'] },
    run: async (args, ctx) => ({ content: await ctx.browser.pressKey(String(args.key)) }),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'integer', description: 'Pixels to scroll (default 600)' },
      },
      required: ['direction'],
    },
    run: async (args, ctx) => ({ content: await ctx.browser.scroll(args.direction, Number(args.amount) || 600) }),
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the browser pane as a PNG, shown to the user and saved to disk (sent to the model only when Settings allows). Refused while a filled credential field has the focus or shows its value on screen.',
    parameters: { type: 'object', properties: {} },
    run: async (_args, ctx) => {
      const shot = await ctx.browser.screenshot();
      return { content: `Screenshot saved to ${shot.path} (${shot.width}x${shot.height}). To put it in your reply for the user, pass this path to show_image.`, image: shot.dataUrl };
    },
  },
  {
    name: 'browser_eval',
    description:
      'Run JavaScript in the current page and return the result as JSON, for inspection and data extraction. Values of password, one-time code and card fields read •••.',
    parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript expression or IIFE' }, ...REASON }, required: ['code'] },
    run: async (args, ctx) => ({ content: await ctx.browser.evaluate(String(args.code)) }),
  },
];

export const browserTools: Tool[] = tools.map(guarded);
