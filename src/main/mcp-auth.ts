// OAuth sign-in for remote MCP servers, on the SDK's own client auth (@modelcontextprotocol/sdk/client/auth.js):
// the OAuthClientProvider the HTTP and SSE transports use, the 127.0.0.1 callback listener, and the token store.
//
// A server that answers 401 is marked needs-auth and nothing more happens: the provider is "passive" then, so the
// SDK may refresh stored tokens but never opens a browser or registers a client. Only signIn() (the user clicked
// "Sign in") runs the interactive flow. Free of Electron: the opener and the store's path are injected.
//
// Tokens live in one JSON file in the app's data folder (mode 0600). Not the keychain: the build is ad-hoc signed, so
// macOS would ask for keychain access again after every update. TokenStore is the seam for a keychain store later.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpOAuthConfig } from '../shared/types';

export const CALLBACK_PATH = '/callback';
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const CLIENT_NAME = 'Silo Harness';

// ---------- Secrets: never logged, cut from every error text ----------

/** Token, code and verifier values seen in this process, so error text that echoes one can be cleaned. */
const knownSecrets = new Set<string>();

export function rememberSecret(value: unknown): void {
  if (typeof value !== 'string' || value.length < 6) return;
  knownSecrets.add(value);
  if (knownSecrets.size > 500) knownSecrets.delete(knownSecrets.values().next().value as string);
}

/** Text with OAuth secrets replaced: known values, Bearer headers, and token-ish fields in query strings and JSON. */
export function redactSecrets(text: string): string {
  let out = String(text);
  for (const s of knownSecrets) if (out.includes(s)) out = out.split(s).join('[redacted]');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[redacted]')
    .replace(/\b(access_token|refresh_token|id_token|code_verifier|client_secret|code|assertion)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/("(?:access_token|refresh_token|id_token|code_verifier|client_secret|code)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');
}

// ---------- Endpoint safety ----------

export class InsecureEndpointError extends Error {
  constructor(url: string, what = 'endpoint') {
    super(`Refused the sign-in ${what} ${safeUrl(url)}: only https (or a 127.0.0.1/localhost address) is allowed.`);
    this.name = 'InsecureEndpointError';
  }
}

/** The server needs sign-in and the user has not asked for it (no browser, no registration until they do). */
export class NeedsSignInError extends Error {
  constructor() {
    super('Sign-in needed.');
    this.name = 'NeedsSignInError';
  }
}

/** An URL's origin and path, without query or fragment (they can carry a code or state). */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid URL)';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** https, or http to the loopback interface. */
export function isSecureOrLoopback(url: string | URL): boolean {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

function checkEndpoint(url: unknown, what: string): void {
  if (url === undefined || url === null || url === '') return;
  if (!isSecureOrLoopback(String(url))) throw new InsecureEndpointError(String(url), what);
}

/** Refuses discovery results whose authorization, token or registration endpoints are not https (or loopback). */
export function checkDiscovery(state: OAuthDiscoveryState): void {
  checkEndpoint(state.authorizationServerUrl, 'server');
  const m = state.authorizationServerMetadata as Record<string, unknown> | undefined;
  if (!m) return;
  checkEndpoint(m.authorization_endpoint, 'authorization endpoint');
  checkEndpoint(m.token_endpoint, 'token endpoint');
  checkEndpoint(m.registration_endpoint, 'registration endpoint');
}

/**
 * fetch for a remote server's transport: requests to the server's own origin go through as configured; anything else
 * (the authorization server, its metadata) must be https or loopback.
 */
export function guardedFetch(serverUrl: URL, base: FetchLike = fetch): FetchLike {
  return (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input.href);
    if (u.origin !== serverUrl.origin && !isSecureOrLoopback(u)) return Promise.reject(new InsecureEndpointError(u.href));
    return base(input, init);
  };
}

// ---------- Token store ----------

/** What is kept for one server: its tokens, its client registration and the discovery result. */
export interface AuthRecord {
  /** The server URL the record belongs to (a changed URL makes it void) */
  url: string;
  tokens?: OAuthTokens;
  client?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  updatedAt?: number;
}

/** Where OAuth records live. The file store is the app's; a keychain store can implement this once the build is Developer ID signed. */
export interface TokenStore {
  get(key: string): Promise<AuthRecord | undefined>;
  set(key: string, record: AuthRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private map = new Map<string, AuthRecord>();
  async get(key: string): Promise<AuthRecord | undefined> {
    const r = this.map.get(key);
    return r ? structuredClone(r) : undefined;
  }
  async set(key: string, record: AuthRecord): Promise<void> {
    this.map.set(key, structuredClone(record));
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

/** One JSON file, mode 0600, written atomically (temp file + rename). Nothing is read or written until first use. */
export class FileTokenStore implements TokenStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<Record<string, AuthRecord>> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as { servers?: unknown };
      return parsed && typeof parsed.servers === 'object' && parsed.servers && !Array.isArray(parsed.servers) ? (parsed.servers as Record<string, AuthRecord>) : {};
    } catch {
      return {}; // a damaged file: start over (the user signs in again)
    }
  }

  private async write(servers: Record<string, AuthRecord>): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify({ version: 1, servers }, null, 2) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, this.file);
  }

  get(key: string): Promise<AuthRecord | undefined> {
    return this.serial(async () => (await this.read())[key]);
  }
  set(key: string, record: AuthRecord): Promise<void> {
    return this.serial(async () => {
      const all = await this.read();
      all[key] = record;
      await this.write(all);
    });
  }
  delete(key: string): Promise<void> {
    return this.serial(async () => {
      const all = await this.read();
      if (!(key in all)) return;
      delete all[key];
      await this.write(all);
    });
  }
}

// ---------- The provider ----------

export interface InteractiveOptions {
  redirectUrl: string;
  state: string;
  /** Opens the authorization URL in the user's browser */
  open: (url: string) => Promise<void>;
}

export interface ProviderOptions {
  /** The store key of this server */
  key: string;
  serverUrl: string;
  store: TokenStore;
  oauth?: McpOAuthConfig;
  /** Present only while the user signs in; without it the provider never opens a browser or registers a client */
  interactive?: InteractiveOptions;
  /** Called after tokens were saved or deleted */
  onChange?: () => void;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  /** Set when the SDK wanted to send the user to the authorization page while passive */
  redirectWanted = false;

  constructor(private readonly opts: ProviderOptions) {}

  private async record(): Promise<AuthRecord> {
    const r = await this.opts.store.get(this.opts.key);
    return r && r.url === this.opts.serverUrl ? r : { url: this.opts.serverUrl };
  }

  private async update(fn: (r: AuthRecord) => void): Promise<void> {
    const r = await this.record();
    fn(r);
    r.updatedAt = Date.now();
    await this.opts.store.set(this.opts.key, r);
  }

  get redirectUrl(): string {
    // A passive provider still answers: without a redirect URL the SDK would take this for a client-credentials client.
    return this.opts.interactive?.redirectUrl ?? `http://127.0.0.1${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.opts.oauth?.scopes;
    return {
      client_name: CLIENT_NAME,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
    };
  }

  state(): string {
    return this.opts.interactive?.state ?? crypto.randomBytes(16).toString('base64url');
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const r = await this.record();
    const configured = this.opts.oauth?.clientId;
    if (configured) {
      // Pre-registered: use the stored copy once it carries the issuer the SDK bound it to.
      return r.client && r.client.client_id === configured ? r.client : { client_id: configured };
    }
    if (this.opts.interactive) {
      // A registration made for another callback port is of no use for this sign-in: register again.
      const uris = (r.client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
      if (r.client && Array.isArray(uris) && !uris.map(String).includes(this.opts.interactive.redirectUrl)) return undefined;
      return r.client;
    }
    // Passive: without a registration there is nothing the SDK may do quietly (registering is the user's call).
    if (!r.client) throw new NeedsSignInError();
    return r.client;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    rememberSecret((info as { client_secret?: unknown }).client_secret);
    await this.update((r) => (r.client = info));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const t = (await this.record()).tokens;
    if (t) {
      rememberSecret(t.access_token);
      rememberSecret(t.refresh_token);
    }
    return t;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    rememberSecret(tokens.access_token);
    rememberSecret(tokens.refresh_token);
    await this.update((r) => (r.tokens = tokens));
    this.opts.onChange?.();
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.interactive) {
      this.redirectWanted = true; // never a browser the user did not ask for
      return;
    }
    if (!isSecureOrLoopback(url)) throw new InsecureEndpointError(url.href, 'authorization page');
    await this.opts.interactive.open(url.href);
  }

  saveCodeVerifier(v: string): void {
    rememberSecret(v);
    this.verifier = v; // memory only
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No sign-in in progress.');
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = undefined;
      return;
    }
    await this.update((r) => {
      if (scope === 'all' || scope === 'tokens') delete r.tokens;
      if (scope === 'all' || scope === 'client') delete r.client;
      if (scope === 'all' || scope === 'discovery') delete r.discovery;
    });
    if (scope === 'all' || scope === 'tokens') this.opts.onChange?.();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    checkDiscovery(state);
    // A server never signed in to gets no record from a passive 401: nothing is written until the user signs in.
    if (!this.opts.interactive && !(await this.record()).client) return;
    await this.update((r) => (r.discovery = state));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const d = (await this.record()).discovery;
    if (d) checkDiscovery(d);
    return d;
  }
}

// ---------- The callback listener ----------

export interface CallbackListener {
  port: number;
  redirectUrl: string;
  /** Resolves with the authorization code of the one accepted callback */
  code: Promise<string>;
  close(): void;
}

const PAGE_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' };

/**
 * Listens on 127.0.0.1 (a free port, or `port`) for the browser's return. Accepts one request on CALLBACK_PATH with
 * the expected state, answers it with a short plain page and closes. A wrong state or an error from the server fails
 * the sign-in. Closes after `timeoutMs` or on close().
 */
export function startCallbackListener(opts: { state: string; port?: number; timeoutMs?: number }): Promise<CallbackListener> {
  return new Promise((resolveListener, rejectListener) => {
    let settle!: (err: Error | null, code?: string) => void;
    const code = new Promise<string>((resolve, reject) => {
      let done = false;
      settle = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        server.close();
        server.closeAllConnections?.();
        if (err) reject(err);
        else resolve(value!);
      };
    });
    code.catch(() => undefined); // the caller awaits it; an unawaited rejection is not a crash
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, PAGE_HEADERS).end('Not found.');
        return;
      }
      const q = url.searchParams;
      if (q.get('state') !== opts.state) {
        res.writeHead(400, PAGE_HEADERS).end('Sign-in failed. You can close this tab.');
        settle(new Error('Sign-in failed: the browser came back with an unexpected state.'));
        return;
      }
      const error = q.get('error');
      if (error) {
        res.writeHead(400, PAGE_HEADERS).end('Sign-in failed. You can close this tab.');
        const desc = (q.get('error_description') ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 200);
        settle(new Error(`Sign-in failed: ${error.replace(/[^\w.-]/g, '').slice(0, 60)}${desc ? ` (${desc})` : ''}.`));
        return;
      }
      const value = q.get('code');
      if (!value) {
        res.writeHead(400, PAGE_HEADERS).end('Sign-in failed. You can close this tab.');
        settle(new Error('Sign-in failed: the browser came back without a code.'));
        return;
      }
      rememberSecret(value);
      res.writeHead(200, PAGE_HEADERS).end('Signed in. You can close this tab.');
      settle(null, value);
    });
    const timer = setTimeout(() => settle(new Error('Sign-in timed out.')), opts.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
    timer.unref?.();
    server.once('error', (err) => {
      clearTimeout(timer);
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      rejectListener(new Error(busy ? `The callback port ${opts.port} is in use.` : `Could not start the sign-in callback: ${err.message}`));
    });
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolveListener({ port, redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`, code, close: () => settle(new Error('Sign-in cancelled.')) });
    });
  });
}

// ---------- The interactive flow ----------

export interface SignInOptions {
  key: string;
  serverUrl: string;
  store: TokenStore;
  oauth?: McpOAuthConfig;
  open: (url: string) => Promise<void>;
  fetchFn?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
  onChange?: () => void;
}

/**
 * The user's sign-in: callback listener, discovery, registration (unless oauth.clientId), the browser, the code
 * exchange (PKCE S256, state checked), tokens stored. Resolves once tokens are stored; rejects with a clean message.
 */
export async function signIn(o: SignInOptions): Promise<void> {
  if (o.signal?.aborted) throw new Error('Sign-in cancelled.');
  const state = crypto.randomBytes(24).toString('base64url');
  const listener = await startCallbackListener({ state, port: o.oauth?.callbackPort, timeoutMs: o.timeoutMs });
  const onAbort = () => listener.close();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const interactive: InteractiveOptions = { redirectUrl: listener.redirectUrl, state, open: o.open };
    const provider = new McpOAuthProvider({ key: o.key, serverUrl: o.serverUrl, store: o.store, oauth: o.oauth, interactive, onChange: o.onChange });
    const scope = o.oauth?.scopes?.length ? o.oauth.scopes.join(' ') : undefined;
    // A stored refresh token may still work: then no browser is needed.
    const first = await Promise.race([auth(provider, { serverUrl: o.serverUrl, scope, fetchFn: o.fetchFn }), listener.code.then(() => 'REDIRECT' as const)]);
    if (first === 'AUTHORIZED') return;
    const code = await listener.code;
    const result = await auth(provider, { serverUrl: o.serverUrl, authorizationCode: code, scope, fetchFn: o.fetchFn });
    if (result !== 'AUTHORIZED') throw new Error('Sign-in failed: no token was issued.');
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
    listener.close();
  }
}

/** Whether a server has tokens stored (for the "Sign out" button). */
export async function hasTokens(store: TokenStore, key: string, serverUrl: string): Promise<boolean> {
  try {
    const r = await store.get(key);
    return !!(r && r.url === serverUrl && r.tokens?.access_token);
  } catch {
    return false;
  }
}
