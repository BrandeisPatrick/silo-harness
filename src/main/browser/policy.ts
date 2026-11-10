// What the agent may do on a site in the Browser pane, as plain functions of plain data: which site a URL belongs
// to, which hosts need no approval (the user's own servers), which sites look like sign-in, email, financial,
// payment or vault sites, what a navigation, a click, a keystroke or a browser_eval may do, and the words on the
// approval card. Nothing here touches Electron, a window or the disk, so test/browser-policy.js covers every rule in
// milliseconds; the browser tools call these to decide and the card shows what they return.
//
// The shape of it follows Claude Code's browser: every site asks once (reading included, since reading is where a
// prompt injection enters), subdomains are sites of their own, and what is the user's alone (money, accounts,
// credentials, CAPTCHAs) is a card with Allow and Deny or a refusal the model reads, whatever the mode.

import os from 'node:os';
import path from 'node:path';
import { domainToUnicode } from 'node:url';
import type { PermissionMode } from '../../shared/types';
import type { CredentialKind } from './safety';

// ---------- The lists ----------

/** What a sensitive site looks like, for the amber note on the card. */
export type SensitiveKind = 'sign-in' | 'email' | 'financial' | 'payment' | 'vault';

const sensitive = (kind: SensitiveKind, patterns: string[]) => patterns.map((pattern) => ({ pattern, kind }));

/**
 * The built-in sensitive sites, listed in Settings → Browser beside the user's own. `host` matches the host and its
 * subdomains (`paypal.com` covers `www.paypal.com`), `*.host` the subdomains only, `prefix.` every host that starts
 * with it. The first match decides the kind. On top of the list, any host with the word "bank" in it is financial
 * (`mybank.example`, `bankofamerica.com`; not `embankment.org`), and a page with a password field is a sign-in page
 * (looksLikeSignInPage).
 */
export const SENSITIVE_PATTERNS: ReadonlyArray<{ pattern: string; kind: SensitiveKind }> = [
  ...sensitive('sign-in', ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'account.apple.com', '*.auth0.com', '*.okta.com', 'login.', 'auth.', 'sso.', 'id.', 'accounts.', 'signin.']),
  ...sensitive('email', ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me', 'fastmail.com', 'icloud.com', 'mail.']),
  ...sensitive('financial', ['paypal.com', 'venmo.com', 'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'citi.com', 'capitalone.com', 'americanexpress.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'robinhood.com', 'coinbase.com', 'binance.com', 'kraken.com', 'revolut.com', 'wise.com', '*.gov', '*.gov.uk']),
  ...sensitive('payment', ['checkout.stripe.com', 'pay.google.com', 'checkout.', 'pay.', '*.adyen.com', '*.braintreegateway.com']),
  ...sensitive('vault', ['vault.bitwarden.com', 'my.1password.com', 'lastpass.com', 'passwords.google.com']),
];

/** "bank" at the start or the end of a label, or set off by a dot, hyphen or digit: not inside another word. */
const BANK_RE = /(^|[^a-z])bank|bank([^a-z]|$)/;

const NOTES: Record<SensitiveKind, string> = {
  'sign-in': 'This looks like a sign-in site',
  email: 'This looks like an email site',
  financial: 'This looks like a financial site',
  payment: 'This looks like a payment page',
  vault: 'This looks like a password vault',
};

/**
 * Hosts the agent may use without a card, with any port: the user's own servers under development. Settings →
 * Browser shows them and the user adds more (`host`, `*.host`, `host:port`, or a folder whose files count). Also
 * exempt, by rule rather than pattern: the artifact: pages the model wrote, and a file: page inside the session's
 * working directory, where read_file is free anyway.
 */
export const BUILT_IN_EXEMPT: readonly string[] = ['localhost', '127.0.0.1', '[::1]', '*.localhost', '*.test'];

/** Schemes the agent never opens: a page of its own belongs in an artifact. */
const OWN_PAGE_SCHEMES = new Set(['javascript', 'data', 'blob', 'chrome', 'devtools', 'view-source', 'about']);

/** Button texts that buy something (whole words, case-insensitive, whitespace collapsed). */
const PURCHASE_PHRASES = ['pay', 'pay now', 'place order', 'place your order', 'order now', 'submit order', 'buy now', 'buy', 'complete purchase', 'complete order', 'complete your order', 'confirm payment', 'confirm purchase', 'confirm order', 'checkout', 'check out', 'purchase', 'subscribe now', 'start subscription', 'start free trial', 'start trial', 'upgrade now'];
/** Button texts that create an account. */
const ACCOUNT_PHRASES = ['create account', 'create an account', 'create your account', 'sign up', 'register', 'join now', 'get started free'];

/** What the model reads when it tries to type a credential: the user does that part. */
export const CREDENTIAL_REFUSAL = 'Not permitted: passwords, one-time codes and card details are for the user to type. Ask them to sign in (or fill the card) in the Browser pane, then continue.';
const CAPTCHA_REFUSAL = 'Not permitted: CAPTCHAs are for the user to solve. Ask them to complete it in the Browser pane, then continue.';
const PLAN_BROWSER_BLOCKED = 'Not permitted in plan mode: the browser is read-only while planning. Describe this step in your plan instead.';

/** The browser tools that only read the page or the pane (browser_tabs: its list and select actions). Plan mode offers these. */
export const READ_ONLY_BROWSER_TOOLS: ReadonlySet<string> = new Set(['browser_navigate', 'browser_get_text', 'browser_read_page', 'browser_find', 'browser_wait_for', 'browser_scroll', 'browser_screenshot', 'browser_tabs']);

// ---------- Sites ----------

/** A site as approvals know it. */
export interface Site {
  /**
   * What approvals are remembered under: the lower-case host, with the port when it is not the scheme's default
   * (`example.com`, `www.example.com`, `localhost:3000`); `file:` and the path for a local file. Subdomains are
   * separate sites, as in Claude Code.
   */
  key: string;
  /**
   * The site as the card names it: the host (and port); both forms of an internationalised name
   * (`xn--pple-43d.com (аpple.com)`) so a look-alike shows; a local file's path with the home folder as ~.
   */
  display: string;
  /** Without the colon: http, https, file, artifact … */
  scheme: string;
  /** The ASCII hostname ('' for a file) */
  host: string;
  /** '' when the scheme's default */
  port: string;
  /** The page's path (and query); a file's decoded path */
  path: string;
}

type Allow = { kind: 'allow' };
type Refuse = { kind: 'refuse'; message: string };
const ALLOW: Allow = { kind: 'allow' };
const refuse = (message: string): Refuse => ({ kind: 'refuse', message });

const clip = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const oneLine = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

function parse(url: string): URL | null {
  try {
    return new URL(String(url ?? '').trim());
  } catch {
    return null;
  }
}

const schemeOf = (u: URL): string => u.protocol.slice(0, -1).toLowerCase();

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** A path with the home folder as ~, for cards. */
function tilde(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * The site a URL belongs to, or null for a URL with no host worth a site (about:blank, data:, javascript:). A web
 * site is keyed by host and non-default port; a file: URL gives a site keyed by its path; an artifact: page is a
 * site of its own so cards can name it, though it is exempt from them.
 */
export function siteOf(url: string): Site | null {
  const u = parse(url);
  if (!u) return null;
  const scheme = schemeOf(u);
  if (scheme === 'file') {
    const p = decodePath(u.pathname);
    return { key: `file:${p}`, display: tilde(p), scheme, host: '', port: '', path: p };
  }
  const host = u.hostname;
  if (!host) return null;
  const port = u.port;
  if (scheme === 'artifact') return { key: `artifact:${host}${u.pathname}`, display: 'this artifact', scheme, host, port, path: u.pathname };
  const unicode = domainToUnicode(host);
  const name = unicode && unicode !== host ? `${host} (${unicode})` : host;
  return { key: port ? `${host}:${port}` : host, display: port ? `${name}:${port}` : name, scheme, host, port, path: u.pathname + u.search };
}

const isWeb = (site: Site): boolean => site.scheme === 'http' || site.scheme === 'https';

/**
 * Whether a host (and port) matches one pattern: `host` (the host itself, or with `subdomains` its subdomains too),
 * `*.host` (subdomains only, never the apex), `host:port` (that port; without one any port matches), `prefix.`
 * (hosts starting with it). Case-insensitive; a pasted URL's scheme and path are ignored.
 */
function matchesHost(pattern: string, host: string, port: string, subdomains: boolean): boolean {
  const p = pattern.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/.*$/, '');
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(p);
  if (!m || !m[1]) return false;
  const [, want, wantPort] = m;
  if (wantPort && wantPort !== port) return false;
  if (want.startsWith('*.')) return host.endsWith(want.slice(1));
  if (want.endsWith('.')) return host.startsWith(want);
  return host === want || (subdomains && host.endsWith(`.${want}`));
}

/** True when `target` is the folder or inside it (both resolved); never with an empty folder. */
function insideFolder(target: string, folder: string): boolean {
  if (!folder) return false;
  const root = path.resolve(folder);
  const abs = path.resolve(target);
  return abs === root || abs.startsWith(root + path.sep);
}

/** A pattern that names a folder (`/path`, `~/path`, `file:///path`) matches the files inside it. */
function matchesFolder(pattern: string, filePath: string): boolean {
  const p = pattern.trim().replace(/^file:\/\//i, '');
  if (!/^[/~]/.test(p)) return false;
  return insideFolder(filePath, decodePath(p.replace(/^~(?=$|\/)/, os.homedir())));
}

const matchesAny = (site: Site, patterns: readonly string[], subdomains: boolean): boolean =>
  site.scheme === 'file' ? patterns.some((p) => matchesFolder(p, site.path) || p.trim() === site.key) : patterns.some((p) => matchesHost(p, site.host, site.port, subdomains));

const isBuiltInExempt = (site: Site): boolean => isWeb(site) && BUILT_IN_EXEMPT.some((p) => matchesHost(p, site.host, site.port, false));

/**
 * Whether the agent may use a page without any card: a built-in local host or one of the user's `extra` patterns
 * (any port unless the pattern names one), an artifact: page, or a file: page inside `cwd` (the folder itself
 * counts) or inside a folder the user listed.
 */
export function isExempt(url: string, extra: readonly string[] = [], cwd = ''): boolean {
  const site = siteOf(url);
  if (!site) return false;
  if (site.scheme === 'artifact') return true;
  if (site.scheme === 'file') return insideFolder(site.path, cwd) || extra.some((p) => matchesFolder(p, site.path));
  if (!isWeb(site)) return false;
  return isBuiltInExempt(site) || extra.some((p) => matchesHost(p, site.host, site.port, false));
}

// ---------- Sensitive sites ----------

/** What isSensitive says: the kind for the card's colour and the amber line to show. */
export interface Sensitivity {
  sensitive: boolean;
  kind: SensitiveKind | null;
  note: string;
}

const NOT_SENSITIVE: Sensitivity = { sensitive: false, kind: null, note: '' };

function sensitiveKindOf(site: Site, extra: readonly string[]): SensitiveKind | null {
  for (const { pattern, kind } of SENSITIVE_PATTERNS) if (matchesHost(pattern, site.host, site.port, true)) return kind;
  if (BANK_RE.test(site.host)) return 'financial';
  if (extra.some((p) => matchesHost(p, site.host, site.port, true))) return 'sign-in';
  return null;
}

/**
 * Whether a page is on a site where every acting call should ask: the built-in list, the "bank" rule, then the
 * user's `extra` patterns (same forms; they read as sign-in sites on the card). Only web pages can be sensitive,
 * and the built-in exempt hosts never are: `login.localhost` is the user's own.
 */
export function isSensitive(url: string, extra: readonly string[] = []): Sensitivity {
  const site = siteOf(url);
  if (!site || !isWeb(site) || isBuiltInExempt(site)) return NOT_SENSITIVE;
  const kind = sensitiveKindOf(site, extra);
  return kind ? { sensitive: true, kind, note: NOTES[kind] } : NOT_SENSITIVE;
}

/** The page signal for sites off the list: a password field makes a sign-in page, which asks before the first acting call. */
export function looksLikeSignInPage(page: { hasPasswordField: boolean }): Sensitivity {
  return page.hasPasswordField ? { sensitive: true, kind: 'sign-in', note: 'This looks like a sign-in page' } : NOT_SENSITIVE;
}

// ---------- Navigation ----------

export type NavigationRule = Allow | { kind: 'ask'; detail: string } | Refuse;

/**
 * Whether the agent may open a URL at all (browser_navigate, browser_tabs new), before the site card: the caller
 * resolves "back", "forward", a relative path or a search phrase to the destination first. The browser's own and
 * code-carrying schemes are refused (an artifact is the way to show a page of the agent's own); a file: page asks
 * with its path unless it is exempt (inside `cwd`, or a folder the user listed), because opening a file in the
 * browser is a read that goes around the file tools' guard. For a file the card is the site card: approving it for
 * the session approves reading the page too (same key). Web pages, about:blank and artifacts pass to siteDecision.
 */
export function navigationRule(url: string, cwd: string, exempt: readonly string[] = []): NavigationRule {
  const u = parse(url);
  if (!u) return refuse(`Not permitted: "${clip(oneLine(url))}" is not a URL the browser can open.`);
  const scheme = schemeOf(u);
  if (scheme === 'about' && u.pathname === 'blank') return ALLOW;
  if (OWN_PAGE_SCHEMES.has(scheme)) return refuse(`Not permitted: the browser does not open ${scheme}: URLs. For a page of your own, make one with create_artifact and open that instead.`);
  if (scheme === 'file') {
    if (isExempt(url, exempt, cwd)) return ALLOW;
    return { kind: 'ask', detail: `Read the local file ${siteOf(url)?.display ?? decodePath(u.pathname)} in the browser` };
  }
  if (scheme === 'http' || scheme === 'https' || scheme === 'artifact') return ALLOW;
  return refuse(`Not permitted: the browser opens http and https pages, local files and artifacts, not ${scheme}: URLs.`);
}

// ---------- The app's own servers ----------

/** What the model reads when it reaches for the app's own remote-control or debugging server. */
export const OWN_SERVER_REFUSAL = "Not permitted: that address is the app's own remote-control or debugging server, which the agent may not open, read or act on.";

/** Whether a host is this machine: a loopback name or address, 0.0.0.0, or one of its own network addresses. */
function isThisMachine(host: string, localAddresses: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || h === '::' || /^127\.\d+\.\d+\.\d+$/.test(h) || /^::ffff:127\./.test(h)) return true;
  return localAddresses.some((a) => a.toLowerCase().replace(/^\[|\]$/g, '') === h);
}

/**
 * Whether the agent may open, read or act on `url` at all, given the ports the app itself listens on (its remote-control
 * server, a --remote-debugging-port, an --inspect port): one of those on this machine (any loopback name, or one of its
 * own LAN addresses) is refused, whatever the path or the mode. Every other local address is left to the exemption.
 */
export function ownServerRule(url: string, ownPorts: readonly number[], localAddresses: readonly string[] = []): Allow | Refuse {
  const u = parse(url);
  if (!u) return ALLOW;
  const scheme = schemeOf(u);
  if (!['http', 'https', 'ws', 'wss'].includes(scheme)) return ALLOW;
  const port = Number(u.port || (scheme === 'https' || scheme === 'wss' ? 443 : 80));
  if (!ownPorts.includes(port) || !isThisMachine(u.hostname, localAddresses)) return ALLOW;
  return refuse(OWN_SERVER_REFUSAL);
}

// ---------- The site decision ----------

/** What a browser tool call does to the page: reads it, acts on it (clicks, types, presses), runs code in it, or opens a URL. */
export type BrowserAction = 'read' | 'act' | 'eval' | 'navigate';

export interface SiteDecisionInput {
  /** The page the call acts on (the active tab's URL, or the destination of a navigation) */
  url: string;
  action: BrowserAction;
  mode: PermissionMode;
  /** The session's working directory, for file: pages */
  cwd: string;
  /** The user's lists from Settings → Browser */
  settings: { exempt: readonly string[]; alwaysAllowed: readonly string[]; sensitive: readonly string[] };
  /** Site keys the user allowed for this session ("Allow example.com for this session") */
  sessionAllowed: ReadonlySet<string>;
  /** The page shows a password field (a sign-in page off the list); the caller passes it until the first act is approved */
  pageHasPasswordField?: boolean;
  /** browser_eval's code, for the guard in auto mode */
  evalCode?: string;
  /**
   * For a page with no site of its own (about:blank, data:): the committed origin it inherited from the page that
   * opened or navigated it, which then decides as that site would. Empty or absent: a blank page of the user's, as before.
   */
  origin?: string;
}

/** Which card to show: the site's first approval with its scopes, a sensitive site's act, or a browser_eval (Allow and Deny). */
export type SiteCard = 'site' | 'sensitive' | 'eval';

export type SiteDecision = Allow | Refuse | { kind: 'ask'; card: SiteCard; site: Site; note?: string; reason?: string };

/**
 * Whether a browser tool call runs, asks or is refused, in this order: a page with no site (about:blank) runs unless
 * it inherited an origin from the page that made it (`origin`), which then decides as that site; an
 * exempt page runs, every action in every mode but plan; plan mode refuses acting and eval everywhere, exempt hosts
 * included (reading and navigating stay, with their cards); bypass mode runs everything else; a site the user has not allowed this session or always asks with
 * the site card, whatever the action (reading included: that is where an injection enters); on an allowed site a
 * browser_eval asks in ask and acceptEdits mode, and in auto mode when the eval guard sees the code reach for site
 * data or the network (the reason goes on the card) or the site is sensitive; an act on a sensitive site (the list,
 * the user's patterns, or a password field on the page) asks with the amber note. `alwaysAllowed` holds site keys
 * as the card saves them and the exempt patterns' forms.
 */
export function siteDecision(input: SiteDecisionInput): SiteDecision {
  const { action, mode, cwd, settings, sessionAllowed } = input;
  const own = siteOf(input.url);
  // A page with no site that a page made takes that page's site: typing into it is typing to that site
  const url = own ? input.url : input.origin && siteOf(input.origin) ? input.origin : input.url;
  const site = own ?? siteOf(url);
  if (!site) return ALLOW;
  // Plan mode is read-only everywhere, the user's own servers included
  if (mode === 'plan' && (action === 'act' || action === 'eval')) return refuse(PLAN_BROWSER_BLOCKED);
  if (isExempt(url, settings.exempt, cwd)) return ALLOW;
  if (mode === 'bypass') return ALLOW;
  const listed = isSensitive(url, settings.sensitive);
  const page = looksLikeSignInPage({ hasPasswordField: Boolean(input.pageHasPasswordField) });
  const note = listed.sensitive ? listed.note : page.sensitive ? page.note : undefined;
  const ask = (card: SiteCard, extra: { note?: string; reason?: string } = {}): SiteDecision => ({ kind: 'ask', card, site, ...(extra.note ? { note: extra.note } : {}), ...(extra.reason ? { reason: extra.reason } : {}) });
  if (!sessionAllowed.has(site.key) && !matchesAny(site, settings.alwaysAllowed, false)) return ask('site', { note });
  if (action === 'eval') {
    if (mode !== 'auto') return ask('eval', { note });
    const reason = evalGuard(input.evalCode ?? '');
    return reason || note ? ask('eval', { note, reason: reason ?? undefined }) : ALLOW;
  }
  if (action === 'act' && note) return ask('sensitive', { note });
  return ALLOW;
}

// ---------- The eval guard ----------

const SENDS = 'sends data from the page';

const EVAL_RULES: ReadonlyArray<[RegExp, string]> = [
  [/\b(localStorage|sessionStorage|indexedDB|caches|cookieStore)\b|\bdocument\s*\.\s*cookie\b/, "reads the site's cookies or storage"],
  [/\bnavigator\s*\.\s*credentials\b/, "asks for the user's saved credentials"],
  [/\b(fetch|import)\s*\(|\b(XMLHttpRequest|sendBeacon|WebSocket|EventSource|postMessage|importScripts|RTCPeerConnection|serviceWorker)\b/, SENDS],
  [/password|passwd|token|secret|credential/i, 'looks for a password, token or secret'],
  [/\.value\b|\bFormData\b|\.\s*(?:forms|elements)\b|\bdefaultValue\b/, "reads a form field's value"],
  [/\b(?:document\s*\.\s*)?location(?:\s*\.\s*(?:href|search|pathname|host|hostname|protocol))?\s*\+?=(?!=)|\blocation\s*\.\s*(?:assign|replace)\s*\(|\bwindow\s*\.\s*open\s*\(/, 'navigates away'],
  // An image, a link, a form or a frame pointed somewhere new carries data out in its URL (after location's own rule)
  [/\.\s*(?:src|href|action|srcdoc)\s*\+?=(?!=)/, SENDS],
  [/\beval\s*\(|\bFunction\s*\(|<script\b|\b(?:inner|outer)HTML\s*\+?=(?!=)|\binsertAdjacentHTML\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(/i, 'runs code in the page'],
];

/**
 * Why a browser_eval should pause for the user in auto mode, in the command guard's words, or null when the code
 * only reads the page (document.title, querySelectorAll(…).length, innerText). It is a plain text match, not a
 * parser: it catches the agent reaching for cookies, storage, the network (a request, a peer connection, a service
 * worker, or an element's src, href, action or srcdoc set to a new URL), credentials, a field's value (also through
 * FormData, document.forms, a form's elements or defaultValue), another page or code injection, not a determined
 * attempt to hide one. Reading a link's href is not sending anything.
 */
export function evalGuard(code: string): string | null {
  const text = String(code ?? '');
  for (const [re, reason] of EVAL_RULES) if (re.test(text)) return reason;
  return null;
}

// ---------- Clicks, typing, keys ----------

/** The element a browser_click lands on, as the page reports it. */
export interface ClickTarget {
  /** Its visible text or label */
  text: string;
  /** Its ARIA role, when it has one ('button', 'link' …) */
  role: string;
  /** Its tag name, any case */
  tag: string;
  /** An input's or button's type ('' when none) */
  type: string;
  /** Inside a reCAPTCHA, hCaptcha or Turnstile widget or frame */
  inCaptcha: boolean;
  /** Its form holds a card number, expiry or security code field */
  formHasCardFields: boolean;
  /** The host its form posts to, when the form has an action of its own */
  formActionHost: string | null;
  /** The click goes into a frame from another site (over the target, or at the point): that frame's origin */
  frameOrigin?: string | null;
  /** The click cannot land where it should (the ref changed, something covers it): the refusal the model reads */
  blocked?: string;
}

/** Whether two looks at what a click lands on found the same thing (the check, then the click itself). */
export function sameClickTarget(a: ClickTarget, b: ClickTarget): boolean {
  return oneLine(a.tag).toLowerCase() === oneLine(b.tag).toLowerCase() && oneLine(a.text) === oneLine(b.text) && oneLine(a.type) === oneLine(b.type) && (a.frameOrigin ?? null) === (b.frameOrigin ?? null);
}

/** What the model reads when the page moved something under the click between the check and the click. */
export const CHANGED_UNDER_CLICK = 'The page changed under the click; nothing was clicked. Read the page again.';

export type ClickRule = Allow | { kind: 'ask'; what: 'purchase' | 'account'; detail: string } | Refuse;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (phrases: string[]): RegExp => new RegExp(`\\b(?:${phrases.map(escapeRe).join('|')})\\b`);
const PURCHASE_RE = phraseRe(PURCHASE_PHRASES);
const ACCOUNT_RE = phraseRe(ACCOUNT_PHRASES);

/** Whether a host is a payment processor's, by the payment patterns of the sensitive list. */
export function isPaymentHost(host: string): boolean {
  const site = siteOf(`https://${String(host ?? '').trim()}`);
  return !!site && SENSITIVE_PATTERNS.some(({ pattern, kind }) => kind === 'payment' && matchesHost(pattern, site.host, site.port, true));
}

/**
 * What a click may do: inside a CAPTCHA it is refused (the user solves those); a button that reads like a purchase
 * ("Pay now", "Place order", "Buy", "Checkout" …), or a submit in a form with card fields or posting to a payment
 * host, asks as a purchase; a button that reads like account creation ("Create account", "Sign up", "Register" …)
 * asks as an account. Both cards have Allow and Deny only, in every mode. A newsletter's plain "Subscribe", a link
 * and "Sign in" are clicks like any other.
 */
export function clickRule(target: ClickTarget): ClickRule {
  if (target.blocked) return refuse(target.blocked);
  if (target.inCaptcha) return refuse(CAPTCHA_REFUSAL);
  const tag = oneLine(target.tag).toLowerCase();
  const type = oneLine(target.type).toLowerCase();
  const role = oneLine(target.role).toLowerCase();
  const isButton = tag === 'button' || role === 'button' || (tag === 'input' && /^(submit|button|image)$/.test(type));
  const isSubmit = (tag === 'input' && /^(submit|image)$/.test(type)) || (tag === 'button' && (type === '' || type === 'submit'));
  const text = oneLine(target.text);
  const ask = (what: 'purchase' | 'account', detail: string): ClickRule => ({ kind: 'ask', what, detail });
  if (isButton && PURCHASE_RE.test(text.toLowerCase())) return ask('purchase', `"${clip(text)}" looks like a purchase`);
  if (isSubmit && target.formHasCardFields) return ask('purchase', 'The form holds card fields');
  if (isSubmit && target.formActionHost && isPaymentHost(target.formActionHost)) return ask('purchase', `The form posts to ${clip(oneLine(target.formActionHost))}, a payment host`);
  if (isButton && ACCOUNT_RE.test(text.toLowerCase())) return ask('account', `"${clip(text)}" looks like account creation`);
  return ALLOW;
}

export type TypeRule = Allow | Refuse;

/**
 * Whether browser_type may put text into a field: a credential field (or a field in a frame from another site,
 * 'embedded', which cannot be looked into) is refused unless the site is exempt, where the user's own app under
 * development is tested with test accounts and the text is hidden as 0.9.1 hides it.
 */
export function typeRule(kind: CredentialKind | 'embedded' | null, exempt: boolean): TypeRule {
  return kind && !exempt ? refuse(CREDENTIAL_REFUSAL) : ALLOW;
}

/** Modifier names in a key combo; with cmd or ctrl a combo is a shortcut, not a character. */
const COMMAND_MODIFIERS = new Set(['cmd', 'command', 'meta', 'ctrl', 'control', 'super', 'win', 'windows']);

/**
 * Whether a key combo puts a character into the focused field: a single character or Space, alone or with shift or
 * alt (which still type a character), not with cmd or ctrl, and not a named key (Enter, Tab, Escape, the arrows,
 * Backspace, Delete, Home, End, Page keys).
 */
export function typesACharacter(combo: string): boolean {
  const raw = String(combo ?? '').trim();
  if (!raw) return false;
  if ([...raw].length === 1) return true;
  const i = raw.endsWith('+') ? raw.length - 1 : raw.lastIndexOf('+');
  const key = i < 0 ? raw : raw.slice(i + 1) || '+';
  const mods = i < 0 ? [] : raw.slice(0, i).split('+').map((m) => m.trim().toLowerCase()).filter(Boolean);
  if (mods.some((m) => COMMAND_MODIFIERS.has(m))) return false;
  return [...key].length === 1 || /^(space|spacebar)$/i.test(key);
}

/**
 * Whether browser_press_key may send a key while a credential field has the focus: a key that types a character
 * into it is refused like browser_type is, unless the site is exempt; Enter, Tab, Escape, the arrows, deletions and
 * shortcuts go through.
 */
export function keyRule(combo: string, focusedKind: CredentialKind | 'embedded' | null, exempt: boolean): TypeRule {
  if (!focusedKind || exempt) return ALLOW;
  return typesACharacter(combo) ? refuse(CREDENTIAL_REFUSAL) : ALLOW;
}

/** What the model reads when it presses a paste, copy or cut shortcut. */
export const CLIPBOARD_REFUSAL = "Not permitted: the clipboard is the user's; type the text with browser_type.";

/**
 * Whether browser_press_key may press a combo that reaches the user's clipboard: paste (cmd/ctrl+v, cmd/ctrl+shift+v,
 * shift+insert), copy (cmd/ctrl+c, ctrl+insert) and cut (cmd/ctrl+x) are refused, so the agent can neither read what
 * the user copied (a password, a code) into a page nor plant something there; on an exempt host (the user's own app)
 * they go through. cmd+a, cmd+z and every other key stay.
 */
export function clipboardRule(combo: string, exempt: boolean): TypeRule {
  if (exempt) return ALLOW;
  const raw = String(combo ?? '').trim().toLowerCase();
  const i = raw.endsWith('+') ? raw.length - 1 : raw.lastIndexOf('+');
  if (i < 0) return ALLOW;
  const key = raw.slice(i + 1).trim();
  const mods = new Set(raw.slice(0, i).split('+').map((m) => m.trim()).filter(Boolean));
  const command = [...mods].some((m) => COMMAND_MODIFIERS.has(m));
  if (command && (key === 'v' || key === 'c' || key === 'x' || key === 'insert')) return refuse(CLIPBOARD_REFUSAL);
  if (mods.has('shift') && key === 'insert') return refuse(CLIPBOARD_REFUSAL);
  return ALLOW;
}

// ---------- For the card and the tools ----------

/** What a browser tool call does to the page, by tool name (browser_tabs: new opens a URL, the rest only look at the pane). */
export function actionOf(toolName: string, args: Record<string, unknown> = {}): BrowserAction {
  if (toolName === 'browser_navigate') return 'navigate';
  if (toolName === 'browser_tabs') return args?.action === 'new' ? 'navigate' : 'read';
  if (toolName === 'browser_eval') return 'eval';
  return READ_ONLY_BROWSER_TOOLS.has(toolName) ? 'read' : 'act';
}

/** Every card a browser tool call can show: siteDecision's three, and a click's purchase and account cards. */
export type BrowserCard = SiteCard | 'purchase' | 'account';

/**
 * The page a password field's question is remembered under once the user allowed acting on it: the site's key and
 * the path without the query (`login?next=/a` and `login?next=/b` are one sign-in page). null for a page with no site.
 */
export function signInPageKey(url: string): string | null {
  const site = siteOf(url);
  return site ? `${site.key}${site.scheme === 'file' ? '' : site.path.replace(/\?.*$/, '')}` : null;
}

/** The site card's wider answers: "Allow example.com for this session", "Always allow example.com" (saved on this Mac). */
export function siteCardLabels(site: Site): { alwaysLabel: string; projectLabel: string } {
  return { alwaysLabel: `Allow ${site.display} for this session`, projectLabel: `Always allow ${site.display}` };
}

/**
 * The card's first line for a browser tool call: `Open example.com`, `Click "Sign in" on accounts.example.com`,
 * `Type into "Search" on example.com`, `Press Enter on example.com`, `Run JavaScript on example.com`, `Read
 * example.com`. Texts are clipped to 80 characters. The text to type is never shown here; for a credential field
 * the caller passes `secret: true` (and the kind as `secretKind`) and the line names the field by kind only.
 */
export function actionLine(toolName: string, args: Record<string, unknown> = {}, site: Site | null = null): string {
  const a = args ?? {};
  const on = site ? ` on ${site.display}` : '';
  const at = site ? site.display : clip(oneLine(a.url));
  switch (toolName) {
    case 'browser_navigate': {
      const url = oneLine(a.url).toLowerCase();
      if (url === 'back') return 'Go back';
      if (url === 'forward') return 'Go forward';
      return `Open ${at || 'a page'}`;
    }
    case 'browser_tabs': {
      const action = oneLine(a.action);
      if (action === 'new') return at ? `Open a new tab at ${at}` : 'Open a new tab';
      if (action === 'close') return a.tab_id ? `Close tab ${clip(oneLine(a.tab_id))}` : 'Close a tab';
      if (action === 'select') return a.tab_id ? `Switch to tab ${clip(oneLine(a.tab_id))}` : 'Switch tabs';
      return 'List the tabs';
    }
    case 'browser_click':
      if (a.text) return `Click "${clip(oneLine(a.text))}"${on}`;
      if (a.ref) return `Click ${clip(oneLine(a.ref))}${on}`;
      if (typeof a.x === 'number' && typeof a.y === 'number') return `Click at (${a.x}, ${a.y})${on}`;
      return `Click${on}`;
    case 'browser_type':
      if (a.secret === true) return `Type into the ${typeof a.secretKind === 'string' && a.secretKind ? a.secretKind : 'password'} field${on}`;
      if (a.field) return `Type into "${clip(oneLine(a.field))}"${on}`;
      if (a.ref) return `Type into ${clip(oneLine(a.ref))}${on}`;
      return `Type into the focused field${on}`;
    case 'browser_press_key':
      return `Press ${clip(oneLine(a.key)) || 'a key'}${on}`;
    case 'browser_eval':
      return `Run JavaScript${on}`;
    default:
      return `Read ${site ? site.display : 'the page'}`;
  }
}
