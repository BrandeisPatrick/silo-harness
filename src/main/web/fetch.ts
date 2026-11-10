// The one way web_fetch and web_search reach the network: plain Node http(s), no cookies, no credentials, nothing that
// identifies the user but the app's name and version. Every connection goes to an address checked first
// (address.ts) and is pinned to it with a custom lookup, so DNS cannot answer differently between the check and the
// connect (rebinding). Redirects are followed by hand, at most five, each hop checked again; one to another site
// (registrable domain) is handed back to the model so the new site gets its own approval. Bodies stop at 5 MB,
// decompressed; a call gives up after 30 s or when the run is stopped.
//
// `NetHooks` let tests point the fetcher at mock servers on 127.0.0.1. They are an argument of the functions here
// only: the tools never pass them from their arguments or the settings.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { blockedReason, isLocalName, registrableDomain } from './address';

/** Test seams: not reachable from a tool's arguments or the settings. */
export interface NetHooks {
  /** Stands in for DNS: the addresses a host name resolves to */
  resolve?(host: string): Promise<string[]>;
  /** An address the checks would refuse that this caller may connect to anyway (a test's 127.0.0.1, the user's SearXNG host) */
  allowAddress?(address: string, host: string): boolean;
  /** Total time for one call (default 30 s) */
  timeoutMs?: number;
  /** Body cap (default 5 MB) */
  maxBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/** What the model reads for an address it may not use: the reason and the way round. */
export class BlockedError extends Error {}

let cachedVersion: string | null = null;
/** "SiloHarness/<version>": the app's own version, else package.json's. */
export function userAgent(): string {
  if (cachedVersion === null) {
    cachedVersion = '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const e = require('electron') as typeof import('electron') | string;
      if (typeof e === 'object' && e?.app?.getVersion) cachedVersion = e.app.getVersion();
    } catch {
      /* not in Electron */
    }
    if (!cachedVersion) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version?: string };
        cachedVersion = String(pkg.version ?? '');
      } catch {
        /* none */
      }
    }
  }
  return cachedVersion ? `SiloHarness/${cachedVersion}` : 'SiloHarness';
}

const LOCAL_HINT = 'web_fetch only reaches public sites; for a local or private server use the browser.';

/**
 * Checks a URL before anything is resolved: http or https, no user name or password, a host. Returns the parsed URL or
 * throws a BlockedError with the reason. Literal addresses (in any form the URL parser accepts) are checked here.
 */
export function checkUrl(raw: string, hooks: NetHooks = {}): URL {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw new BlockedError(`"${String(raw).slice(0, 200)}" is not a valid URL.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedError(`Only http and https URLs can be fetched, not ${u.protocol}`);
  if (u.username || u.password) throw new BlockedError('URLs with a user name or password are not fetched.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new BlockedError('The URL has no host.');
  if (net.isIP(host)) {
    const why = blockedReason(host);
    if (why && !hooks.allowAddress?.(host, host)) throw new BlockedError(`${host} is a ${why} address. ${LOCAL_HINT}`);
  } else if (isLocalName(host) && !hooks.allowAddress?.(host, host)) {
    throw new BlockedError(`${host} is a local name. ${LOCAL_HINT}`);
  }
  return u;
}

/** The addresses to connect to for a host, every one of them checked; the first is used. */
export async function resolvePublic(host: string, hooks: NetHooks = {}): Promise<{ address: string; family: 4 | 6 }> {
  const bare = host.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (net.isIP(bare)) addresses = [bare];
  else if (hooks.resolve) addresses = await hooks.resolve(bare);
  else {
    try {
      addresses = (await dns.promises.lookup(bare, { all: true, verbatim: true })).map((r) => r.address);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(code === 'ENOTFOUND' || code === 'EAI_NONAME' ? `${bare} was not found (DNS).` : `Could not resolve ${bare} (${code ?? 'DNS error'}).`);
    }
  }
  if (!addresses.length) throw new Error(`${bare} has no address.`);
  // Every answer must be public: a name that also points inside the network is refused as a whole.
  for (const a of addresses) {
    const why = blockedReason(a);
    if (why && !hooks.allowAddress?.(a, bare)) throw new BlockedError(`${bare} resolves to a ${why} address (${a}). ${LOCAL_HINT}`);
  }
  const address = addresses[0];
  return { address, family: net.isIPv6(address) ? 6 : 4 };
}

export interface RawResponse {
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body, decompressed, up to the cap; empty when `wantBody` said no */
  body: Buffer;
  /** The body went past the cap and was cut there */
  truncated: boolean;
  /** Bytes the server said it would send (content-length), when it said */
  declaredSize: number | null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  hooks?: NetHooks;
  /** Asked once the headers are in: false skips the body (a binary type) */
  wantBody?(status: number, headers: http.IncomingHttpHeaders): boolean;
  /** Give up connecting after this long (the https attempt before falling back to http) */
  connectTimeoutMs?: number;
  /** The address already resolved and checked for this host (one hop's https and http attempts share it) */
  pinned?: { address: string; family: 4 | 6 };
}

/** A connection-level failure before any response: what makes an upgraded https attempt fall back to http. */
export class ConnectError extends Error {}

/** One request to one URL, connected to a checked and pinned address. Does not follow redirects. */
export async function request(url: URL, opts: RequestOptions): Promise<RawResponse> {
  const hooks = opts.hooks ?? {};
  checkUrl(url.href, hooks);
  const { address, family } = opts.pinned ?? (await resolvePublic(url.hostname, hooks));
  const maxBytes = hooks.maxBytes ?? MAX_BODY_BYTES;
  const mod = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string> = {
    'User-Agent': userAgent(),
    Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en',
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
  // Pinned: whatever the socket asks for, it gets the address checked above.
  const lookup = (_host: string, o: dns.LookupOptions | ((...a: unknown[]) => void), cb?: (...a: unknown[]) => void) => {
    const done = (typeof o === 'function' ? o : cb)!;
    const all = typeof o === 'object' && o?.all;
    if (all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: opts.method ?? 'GET',
        headers,
        lookup: lookup as never,
        agent: false,
        signal: opts.signal,
        servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
      },
      (res) => {
        gotResponse = true;
        if (connectTimer) clearTimeout(connectTimer);
        const status = res.statusCode ?? 0;
        const len = Number(res.headers['content-length']);
        const declaredSize = Number.isFinite(len) && len >= 0 ? len : null;
        const base = { url: url.href, status, headers: res.headers, declaredSize };
        if (opts.wantBody && !opts.wantBody(status, res.headers)) {
          res.destroy();
          settled = true;
          resolve({ ...base, body: Buffer.alloc(0), truncated: false });
          return;
        }
        let stream: Readable = res;
        const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({ ...base, body: Buffer.concat(chunks), truncated });
        };
        stream.on('data', (c: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (c.length > room) {
            if (room > 0) chunks.push(c.subarray(0, room));
            size = maxBytes;
            truncated = true;
            finish();
            res.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        stream.on('end', finish);
        stream.on('error', (err) => (truncated ? finish() : fail(abortedOr(err, opts.signal))));
        res.on('error', (err) => (truncated ? finish() : fail(abortedOr(err, opts.signal))));
        res.on('aborted', () => fail(abortedOr(new Error('The connection closed early.'), opts.signal)));
      },
    );
    let connectTimer: NodeJS.Timeout | null = null;
    if (opts.connectTimeoutMs) {
      connectTimer = setTimeout(() => {
        if (!gotResponse) {
          fail(new ConnectError('Timed out connecting.'));
          req.destroy();
        }
      }, opts.connectTimeoutMs);
    }
    req.on('error', (err) => {
      if (connectTimer) clearTimeout(connectTimer);
      if (opts.signal.aborted) return fail(abortedOr(err, opts.signal));
      fail(gotResponse ? err : new ConnectError(err.message));
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** The error to report when a request failed: the abort's reason when the call was stopped or timed out. */
function abortedOr(err: Error, signal: AbortSignal): Error {
  if (!signal.aborted) return err;
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted.');
}

export class TimeoutError extends Error {}
export class StoppedError extends Error {}

/** A signal that aborts on the caller's (the run was stopped) or after `ms`, with an error that says which. */
export function deadline(ms: number, outer?: AbortSignal): { signal: AbortSignal; clear(): void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new TimeoutError(`Timed out after ${Math.round(ms / 1000)} s.`)), ms);
  const onAbort = () => ctl.abort(new StoppedError('Stopped.'));
  if (outer?.aborted) onAbort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    clear() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

// ---------- Fetching a page ----------

/** Text types web_fetch reads; the rest gets one line. */
export function isTextType(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.startsWith('text/') || m === 'application/json' || m.endsWith('+json') || m === 'application/xml' || m.endsWith('+xml') || m === 'application/javascript' || m === 'application/ecmascript' || m === 'application/x-ndjson' || m === '';
}

export function mimeOf(headers: http.IncomingHttpHeaders): string {
  return String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

/** The charset a response says, from its header or (HTML) its first bytes; utf-8 when it says nothing. */
export function charsetOf(headers: http.IncomingHttpHeaders, body: Buffer): string {
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8';
  if (body[0] === 0xff && body[1] === 0xfe) return 'utf-16le';
  if (body[0] === 0xfe && body[1] === 0xff) return 'utf-16be';
  const header = /charset\s*=\s*["']?([\w.:-]+)/i.exec(String(headers['content-type'] ?? ''));
  if (header) return header[1].toLowerCase();
  const head = body.subarray(0, 2048).toString('latin1');
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  const xml = /^<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  if (xml) return xml[1].toLowerCase();
  return 'utf-8';
}

export function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export type FetchOutcome =
  | { kind: 'text'; url: string; mime: string; text: string; truncated: boolean; status: number }
  | { kind: 'binary'; url: string; mime: string; size: number | null }
  | { kind: 'redirect'; url: string; to: string };

export interface FetchOptions {
  signal?: AbortSignal;
  hooks?: NetHooks;
  /**
   * Before a redirect to another host of the same site is followed: null to go on, or the message to stop with
   * (web_fetch asks for that host's approval here).
   */
  beforeHop?(url: string): Promise<string | null>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * GETs a URL: http upgraded to https first (http only when https cannot connect), redirects by hand (at most five,
 * each checked; another site is handed back), text types decoded by their charset, other types reported by size.
 */
export async function fetchUrl(raw: string, opts: FetchOptions = {}): Promise<FetchOutcome> {
  const hooks = opts.hooks ?? {};
  const first = checkUrl(raw, hooks);
  const site = registrableDomain(first.hostname);
  const dl = deadline(hooks.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.signal);
  try {
    let url = first;
    for (let hop = 0; ; hop++) {
      const wantBody = (status: number, h: http.IncomingHttpHeaders) => !REDIRECTS.has(status) && isTextType(mimeOf(h));
      let res: RawResponse;
      // Resolved and checked once per hop; both attempts below connect to this address
      const pinned = await resolvePublic(url.hostname, hooks);
      if (url.protocol === 'http:' && hop === 0) {
        const secure = new URL(url.href);
        secure.protocol = 'https:';
        if (secure.port === '80') secure.port = '';
        try {
          res = await request(secure, { signal: dl.signal, hooks, wantBody, pinned, connectTimeoutMs: 10_000 });
        } catch (err) {
          if (!(err instanceof ConnectError) || dl.signal.aborted) throw err;
          res = await request(url, { signal: dl.signal, hooks, wantBody, pinned });
        }
      } else {
        res = await request(url, { signal: dl.signal, hooks, wantBody, pinned });
      }
      if (REDIRECTS.has(res.status) && res.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}).`);
        let next: URL;
        try {
          next = new URL(String(res.headers.location), res.url);
        } catch {
          throw new Error(`The page redirects to an address that is not valid: ${String(res.headers.location).slice(0, 200)}`);
        }
        next.hash = '';
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new BlockedError(`The page redirects to a ${next.protocol} URL, which is not fetched.`);
        if (registrableDomain(next.hostname) !== site) return { kind: 'redirect', url: res.url, to: next.href };
        checkUrl(next.href, hooks);
        if (next.hostname !== url.hostname && opts.beforeHop) {
          const stop = await opts.beforeHop(next.href);
          if (stop) throw new BlockedError(stop);
        }
        url = next;
        continue;
      }
      const mime = mimeOf(res.headers);
      if (res.status >= 400) {
        const text = res.body.length ? decodeBody(res.body, charsetOf(res.headers, res.body)) : '';
        throw new HttpError(res.status, text);
      }
      if (!isTextType(mime)) return { kind: 'binary', url: res.url, mime, size: res.declaredSize };
      return { kind: 'text', url: res.url, mime, text: decodeBody(res.body, charsetOf(res.headers, res.body)), truncated: res.truncated, status: res.status };
    }
  } finally {
    dl.clear();
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}${http.STATUS_CODES[status] ? ` ${http.STATUS_CODES[status]}` : ''}`);
  }
}
