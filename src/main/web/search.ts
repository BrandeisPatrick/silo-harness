// web_search's backends behind one interface, chosen by AppConfig.webSearch: DuckDuckGo (keyless, its HTML page),
// Brave, Tavily and Exa (an API key each) and SearXNG (the user's own instance, by its address). Each request goes
// through fetch.ts's checked, pinned connection; SearXNG alone may be on a private address, and only the host the
// user configured. Parsers are plain functions of the response, so tests run them against recorded fixtures. The key
// never leaves this file except in the provider's own header: errors are redacted before anyone reads them.

import type { AppConfig, WebSearchConfig } from '../../shared/types';
import { decodeEntities, parseHtml, textOf, walk, type El } from './html';
import { deadline, request, type NetHooks, type RawResponse } from './fetch';

export type SearchProvider = NonNullable<WebSearchConfig['provider']>;
export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['duckduckgo', 'brave', 'tavily', 'exa', 'searxng'];
export const PROVIDER_LABELS: Record<SearchProvider, string> = { duckduckgo: 'DuckDuckGo', brave: 'Brave', tavily: 'Tavily', exa: 'Exa', searxng: 'SearXNG' };
const NEEDS_KEY = new Set<SearchProvider>(['brave', 'tavily', 'exa']);

export interface SearchSettings {
  provider: SearchProvider;
  apiKey: string;
  baseUrl: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** A failure the model reads as one line: rate limits, blocks, a missing key. */
export class SearchError extends Error {}

export const SEARCH_TIMEOUT_MS = 20_000;
export const MAX_SNIPPET = 300;

export function searchSettings(cfg: Pick<AppConfig, 'webSearch'> | undefined): SearchSettings {
  const w = cfg?.webSearch ?? {};
  const provider = SEARCH_PROVIDERS.includes(w.provider as SearchProvider) ? (w.provider as SearchProvider) : 'duckduckgo';
  return { provider, apiKey: typeof w.apiKey === 'string' ? w.apiKey.trim() : '', baseUrl: typeof w.baseUrl === 'string' ? w.baseUrl.trim() : '' };
}

/** The host a search goes to, for the approval card ('' when SearXNG has no address yet). */
export function providerHost(s: SearchSettings): string {
  switch (s.provider) {
    case 'duckduckgo':
      return 'html.duckduckgo.com';
    case 'brave':
      return 'api.search.brave.com';
    case 'tavily':
      return 'api.tavily.com';
    case 'exa':
      return 'api.exa.ai';
    case 'searxng':
      try {
        return new URL(s.baseUrl).host;
      } catch {
        return '';
      }
  }
}

/** `text` with the key (and its URL-encoded form) taken out. */
export function redactKey(text: string, key: string): string {
  if (!key || key.length < 4) return text;
  let out = text.split(key).join('…');
  const enc = encodeURIComponent(key);
  if (enc !== key) out = out.split(enc).join('…');
  return out;
}

const clip = (s: string, max = MAX_SNIPPET): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const oneLine = (s: unknown): string => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function result(title: unknown, url: unknown, snippet: unknown): SearchResult | null {
  const u = String(url ?? '').trim();
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { title: clip(oneLine(title) || u, 200), url: u, snippet: clip(oneLine(snippet)) };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---------- Parsers ----------

/** DuckDuckGo's result link: "//duckduckgo.com/l/?uddg=<the URL>&rut=…" unwrapped; ads (y.js) dropped. */
export function unwrapDuckDuckGo(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href, 'https://duckduckgo.com/');
  } catch {
    return null;
  }
  if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) {
    if (u.pathname === '/l/' || u.pathname === '/l') return u.searchParams.get('uddg');
    return null; // y.js (ads) and the site's own pages
  }
  return u.href;
}

const classes = (e: El): string[] => (e.attrs.class ?? '').split(/\s+/).filter(Boolean);

/** Results from DuckDuckGo's HTML page; throws SearchError when the page is its bot check. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  if (/anomaly-modal|challenge-form|g-recaptcha|Unfortunately, bots use DuckDuckGo too/i.test(html)) {
    throw new SearchError('DuckDuckGo blocked the request (it does this to automated searches). Try again later, or set webSearch.provider to brave, tavily, exa or searxng in Settings → Browser.');
  }
  const root = parseHtml(html);
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const e of walk(root)) {
    const cls = classes(e);
    if (!cls.includes('result') && !cls.includes('web-result')) continue;
    if (cls.some((c) => c === 'result--ad' || c.startsWith('result--ad'))) continue;
    let link: El | null = null;
    let snippet: El | null = null;
    for (const d of walk(e)) {
      const dc = classes(d);
      if (!link && d.tag === 'a' && dc.includes('result__a')) link = d;
      if (!snippet && dc.includes('result__snippet')) snippet = d;
    }
    if (!link) continue;
    const url = unwrapDuckDuckGo(link.attrs.href ?? '');
    if (!url || seen.has(url)) continue;
    const r = result(textOf(link), url, snippet ? textOf(snippet) : '');
    if (r) {
      seen.add(url);
      out.push(r);
    }
  }
  return out;
}

export function parseBrave(json: unknown): SearchResult[] {
  const web = isObj(json) && isObj(json.web) ? json.web : {};
  return list((web as Record<string, unknown>).results)
    .filter(isObj)
    .map((r) => result(r.title, r.url, r.description || list(r.extra_snippets)[0]))
    .filter((r): r is SearchResult => !!r);
}

export function parseTavily(json: unknown): SearchResult[] {
  return list(isObj(json) ? json.results : null)
    .filter(isObj)
    .map((r) => result(r.title, r.url, r.content))
    .filter((r): r is SearchResult => !!r);
}

export function parseExa(json: unknown): SearchResult[] {
  return list(isObj(json) ? json.results : null)
    .filter(isObj)
    .map((r) => result(r.title, r.url, r.summary || list(r.highlights)[0] || r.text))
    .filter((r): r is SearchResult => !!r);
}

export function parseSearxng(json: unknown): SearchResult[] {
  return list(isObj(json) ? json.results : null)
    .filter(isObj)
    .map((r) => result(r.title, r.url, r.content))
    .filter((r): r is SearchResult => !!r);
}

// ---------- Running a search ----------

export interface SearchOptions {
  signal?: AbortSignal;
  hooks?: NetHooks;
  /** Test seam: where each provider's endpoint is (default: the real one) */
  endpoints?: Partial<Record<SearchProvider, string>>;
}

const ENDPOINTS: Record<Exclude<SearchProvider, 'searxng'>, string> = {
  duckduckgo: 'https://html.duckduckgo.com/html/',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  tavily: 'https://api.tavily.com/search',
  exa: 'https://api.exa.ai/search',
};

function parseJson(res: RawResponse, label: string): unknown {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new SearchError(`${label} sent a reply that is not JSON${res.truncated ? ' (too large)' : ''}.`);
  }
}

/** The one-line error for a status that is not a success. */
function statusError(s: SearchSettings, status: number): SearchError {
  const label = PROVIDER_LABELS[s.provider];
  if (status === 429) return new SearchError(`${label} rate-limited the search. Try again later, or choose another provider (webSearch.provider in Settings → Browser).`);
  if (s.provider === 'duckduckgo' && (status === 202 || status === 403)) {
    return new SearchError('DuckDuckGo blocked the request (it does this to automated searches). Try again later, or set webSearch.provider to brave, tavily, exa or searxng in Settings → Browser.');
  }
  if ((status === 401 || status === 403) && NEEDS_KEY.has(s.provider)) return new SearchError(`${label} refused the API key (webSearch.apiKey in Settings → Browser).`);
  if (s.provider === 'searxng' && status === 403) return new SearchError('SearXNG refused the request: enable the json format in its settings.yml (search.formats), or check webSearch.baseUrl.');
  if (status >= 300 && status < 400) return new SearchError(`${label} answered with a redirect (HTTP ${status}); check the provider settings (webSearch).`);
  return new SearchError(`${label} answered HTTP ${status}.`);
}

/**
 * Runs one search. `count` is 1 to 10; `site` limits it to one site (as the provider allows: a domain filter, or
 * "site:" in the query). Throws SearchError with a one-line message the model can read; the key is never in it.
 */
export async function runSearch(s: SearchSettings, query: string, count: number, site: string | undefined, opts: SearchOptions = {}): Promise<SearchResult[]> {
  const label = PROVIDER_LABELS[s.provider];
  if (NEEDS_KEY.has(s.provider) && !s.apiKey) throw new SearchError(`${label} needs an API key: set webSearch.apiKey in Settings → Browser.`);
  if (s.provider === 'searxng' && !providerHost(s)) throw new SearchError('SearXNG needs its address: set webSearch.baseUrl in Settings → Browser.');
  const q = site ? `${query} site:${site}` : query;
  const dl = deadline(opts.hooks?.timeoutMs ?? SEARCH_TIMEOUT_MS, opts.signal);
  const hooks: NetHooks = { ...opts.hooks, maxBytes: Math.min(opts.hooks?.maxBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024) };
  try {
    let res: RawResponse;
    const json = { Accept: 'application/json' };
    const go = (url: URL, extra: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; hooks?: NetHooks } = {}) =>
      request(url, { signal: dl.signal, hooks: extra.hooks ?? hooks, method: extra.method, headers: extra.headers, body: extra.body });
    switch (s.provider) {
      case 'duckduckgo': {
        const url = new URL(opts.endpoints?.duckduckgo ?? ENDPOINTS.duckduckgo);
        url.searchParams.set('q', q);
        res = await go(url, { headers: { Accept: 'text/html' } });
        if (res.status !== 200) throw statusError(s, res.status);
        return parseDuckDuckGo(res.body.toString('utf8')).slice(0, count);
      }
      case 'brave': {
        const url = new URL(opts.endpoints?.brave ?? ENDPOINTS.brave);
        url.searchParams.set('q', q);
        url.searchParams.set('count', String(count));
        res = await go(url, { headers: { ...json, 'X-Subscription-Token': s.apiKey } });
        if (res.status !== 200) throw statusError(s, res.status);
        return parseBrave(parseJson(res, label)).slice(0, count);
      }
      case 'tavily': {
        const url = new URL(opts.endpoints?.tavily ?? ENDPOINTS.tavily);
        const body = JSON.stringify({ query, max_results: count, ...(site ? { include_domains: [site] } : {}) });
        res = await go(url, { method: 'POST', headers: { ...json, 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` }, body });
        if (res.status !== 200) throw statusError(s, res.status);
        return parseTavily(parseJson(res, label)).slice(0, count);
      }
      case 'exa': {
        const url = new URL(opts.endpoints?.exa ?? ENDPOINTS.exa);
        const body = JSON.stringify({ query, numResults: count, ...(site ? { includeDomains: [site] } : {}), contents: { text: { maxCharacters: 400 } } });
        res = await go(url, { method: 'POST', headers: { ...json, 'Content-Type': 'application/json', 'x-api-key': s.apiKey }, body });
        if (res.status !== 200) throw statusError(s, res.status);
        return parseExa(parseJson(res, label)).slice(0, count);
      }
      case 'searxng': {
        const base = new URL(s.baseUrl.endsWith('/') ? s.baseUrl : `${s.baseUrl}/`);
        const url = new URL('search', base);
        url.searchParams.set('q', q);
        url.searchParams.set('format', 'json');
        // The user's own instance may be on their network: that one host, and no other, may be a private address.
        const host = base.hostname.replace(/^\[|\]$/g, '');
        const own: NetHooks = { ...hooks, allowAddress: (a, h) => h.replace(/^\[|\]$/g, '') === host || !!hooks.allowAddress?.(a, h) };
        res = await go(url, { headers: json, hooks: own });
        if (res.status !== 200) throw statusError(s, res.status);
        return parseSearxng(parseJson(res, label)).slice(0, count);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SearchError(redactKey(err instanceof SearchError ? msg : `${label} search failed: ${msg}`, s.apiKey));
  } finally {
    dl.clear();
  }
}
