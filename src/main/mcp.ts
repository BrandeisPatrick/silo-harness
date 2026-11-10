// MCP (Model Context Protocol) servers: external tool providers the model calls as mcp__<server>__<tool>, the
// naming Claude Code uses. Servers come from the app's settings (user scope) and from <workingDirectory>/.mcp.json
// (project scope, the file Claude Code reads too) and run as child processes (stdio) or over HTTP.

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AppConfig, McpOAuthConfig, McpScope, McpServerConfig, McpServerInfo, McpStatus, McpToolInfo } from '../shared/types';
import type { Tool, ToolResult } from './tools/types';
import { words } from './guard';
import { expandEnvRefs } from './env';
import { guardedFetch, hasTokens, InsecureEndpointError, McpOAuthProvider, MemoryTokenStore, NeedsSignInError, redactSecrets, signIn as runSignIn, type TokenStore } from './mcp-auth';

export const PROJECT_FILE = '.mcp.json';
const NAME_RE = /^[\w.-]{1,64}$/;
const CONNECT_TIMEOUT_MS = 60_000; // "npx -y …" may download the server on first use
const CALL_TIMEOUT_MS = 120_000;
/** A call whose server keeps sending progress may run this long in all (or its own timeout, when longer) */
const MAX_TOTAL_CALL_MS = 10 * 60_000;
const MAX_TOOL_NAME = 64;
const STDERR_LINES = 12;
const MAX_DETAIL = 2000;
/** Server instructions kept (untrusted text from the server) */
export const MAX_INSTRUCTIONS = 2000;
/** A text result longer than this is written to a file; the model gets its start and end and the path */
export const SPILL_OVER_CHARS = 100_000;
export const SPILL_HEAD_CHARS = 60_000;
export const SPILL_TAIL_CHARS = 10_000;
const SPILL_MAX_AGE_MS = 24 * 3600_000;

export interface McpManagerOptions {
  getConfig: () => AppConfig;
  /** Persists changed settings (user servers, trusted project servers) */
  saveConfig: (patch: Partial<AppConfig>) => void;
  cwd: () => string;
  version?: string;
  /** OAuth for remote servers: where tokens are kept, and how the authorization page is opened (shell.openExternal) */
  auth?: { store: TokenStore; openExternal: (url: string) => Promise<void>; signInTimeoutMs?: number };
  /** Where big tool results are written (default <os tmp>/silo-harness/mcp-results) */
  resultsDir?: string;
  /** Automatic reconnection of remote servers (tests shorten it) */
  reconnect?: { tries?: number; baseMs?: number; maxMs?: number };
  /** How long a connect may take, and how long a call waits for a reconnecting server (default 60 s) */
  connectTimeoutMs?: number;
  /** Waits between reconnection tries (tests inject one) */
  sleep?: (ms: number) => Promise<void>;
}

interface Entry {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  /** JSON of the config: a changed signature means disconnect and reconnect */
  signature: string;
  status: McpStatus;
  error?: string;
  tools: McpToolInfo[];
  sdkTools: SdkTool[];
  client: Client | null;
  transport: 'stdio' | 'http' | 'sse';
  serverInfo?: { name: string; version: string };
  stderr: string[];
  /** Bumped on every connect and disconnect so results of a superseded attempt are ignored */
  generation: number;
  /** Tools filtered out by enabledTools/disabledTools */
  hiddenTools: string[];
  /** The server's `instructions`, capped (untrusted) */
  instructions?: string;
  /** A stdio server that exited after it was connected: respawned once on the next tool call */
  respawn?: boolean;
  /** The automatic reconnection in progress, if any */
  loop?: { cancelled: boolean } | null;
  /** The sign-in in progress, if any */
  signIn?: AbortController | null;
  /** OAuth tokens are stored for this server */
  signedIn?: boolean;
  /** Why the last connection attempt failed */
  lastError?: string;
}

export interface McpToolRef {
  server: string;
  scope: McpScope;
  tool: string;
  readOnly: boolean;
  destructive: boolean;
}

interface ToolIndexEntry {
  entry: Entry;
  tool: SdkTool;
  info: McpToolInfo;
}

const keyOf = (scope: McpScope, name: string) => `${scope}:${name}`;

/** `${VAR}` and `${VAR:-default}` in strings of a config, as Claude Code expands them in .mcp.json. */
export { expandEnvRefs };

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

/** The transport a config uses (stdio when it has a command). */
export function transportOf(c: McpServerConfig): 'stdio' | 'http' | 'sse' {
  if ('url' in c && c.url) return c.type === 'sse' ? 'sse' : 'http';
  return 'stdio';
}

/** The command line or URL, for display. */
export function targetOf(c: McpServerConfig): string {
  if ('url' in c && c.url) return c.url;
  const s = c as { command: string; args?: string[] };
  return [s.command, ...(s.args ?? [])].map((w) => (/\s/.test(w) ? JSON.stringify(w) : w)).join(' ');
}

/** Checks and trims a raw config object (from settings, .mcp.json or a pasted snippet). Throws on an unusable one. */
export function normalizeServerConfig(raw: unknown): McpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('a server entry must be an object');
  const r = raw as Record<string, unknown>;
  const disabled = r.disabled === true ? true : undefined;
  const strMap = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object of strings`);
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
    return Object.keys(out).length ? out : undefined;
  };
  const type = typeof r.type === 'string' ? r.type.toLowerCase() : undefined;
  const nameList = (v: unknown, what: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`"${what}" must be a list of tool names`);
    return v.map((x: string) => x.trim()).filter(Boolean);
  };
  let timeout: number | undefined;
  if (r.timeout !== undefined && r.timeout !== null) {
    if (typeof r.timeout !== 'number' || !Number.isInteger(r.timeout) || r.timeout < 1000 || r.timeout > 86_400_000) throw new Error('"timeout" must be a whole number of milliseconds from 1000 to 86400000');
    timeout = r.timeout;
  }
  const options = { disabled, timeout, enabledTools: nameList(r.enabledTools, 'enabledTools'), disabledTools: nameList(r.disabledTools, 'disabledTools') };
  const clean = <T extends object>(o: T): T => {
    for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
    return o;
  };
  if (typeof r.url === 'string' && r.url.trim()) {
    const url = r.url.trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" is not an http(s) URL`);
    const t: 'http' | 'sse' = type === 'sse' ? 'sse' : 'http';
    return clean({ type: t, url, headers: strMap(r.headers, 'headers'), oauth: normalizeOAuth(r.oauth), ...options });
  }
  if (typeof r.command === 'string' && r.command.trim()) {
    if (type && type !== 'stdio') throw new Error(`transport "${type}" needs a "url"`);
    if (r.oauth !== undefined) throw new Error('"oauth" is for servers with a "url"');
    const args = r.args === undefined ? undefined : Array.isArray(r.args) ? r.args.map((a) => String(a)) : (() => { throw new Error('"args" must be a list'); })();
    const cwd = typeof r.cwd === 'string' && r.cwd.trim() ? r.cwd.trim() : undefined;
    return clean({ type: 'stdio' as const, command: r.command.trim(), args, env: strMap(r.env, 'env'), cwd, ...options });
  }
  throw new Error('a server entry needs a "command" (stdio) or a "url" (http)');
}

function normalizeOAuth(v: unknown): McpOAuthConfig | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('"oauth" must be an object');
  const o = v as Record<string, unknown>;
  const out: McpOAuthConfig = {};
  if (o.clientId !== undefined) {
    if (typeof o.clientId !== 'string' || !o.clientId.trim()) throw new Error('"oauth.clientId" must be a string');
    out.clientId = o.clientId.trim();
  }
  if (o.callbackPort !== undefined) {
    if (typeof o.callbackPort !== 'number' || !Number.isInteger(o.callbackPort) || o.callbackPort < 1024 || o.callbackPort > 65535) throw new Error('"oauth.callbackPort" must be a port from 1024 to 65535');
    out.callbackPort = o.callbackPort;
  }
  if (o.scopes !== undefined) {
    const list = typeof o.scopes === 'string' ? o.scopes.split(/\s+/) : Array.isArray(o.scopes) && o.scopes.every((x) => typeof x === 'string') ? (o.scopes as string[]) : null;
    if (!list) throw new Error('"oauth.scopes" must be a list of scopes');
    const scopes = list.map((x) => x.trim()).filter(Boolean);
    if (scopes.length) out.scopes = scopes;
  }
  return out;
}

/**
 * Turns what the user typed in the "Add server" form into configs by name: a JSON snippet ({"command": …},
 * {"type": "http", "url": …} or a whole {"mcpServers": {…}} block), a URL, or a command line.
 */
export function parseServerSpec(name: string, spec: string, env?: Record<string, string>): Record<string, McpServerConfig> {
  const text = spec.trim();
  if (!text) throw new Error('Enter a command line, a URL or a JSON snippet.');
  const cleanName = name.trim();
  const needName = () => {
    if (!cleanName) throw new Error('Give the server a name.');
    if (!NAME_RE.test(cleanName)) throw new Error('Server names use letters, digits, ".", "-" and "_" (at most 64 characters).');
    return cleanName;
  };
  const withEnv = (c: McpServerConfig): McpServerConfig => {
    if (!env || !Object.keys(env).length || transportOf(c) !== 'stdio') return c;
    const s = c as Extract<McpServerConfig, { command: string }>;
    return { ...s, env: { ...(s.env ?? {}), ...env } };
  };
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`The JSON could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
      const out: Record<string, McpServerConfig> = {};
      for (const [n, raw] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
        if (!NAME_RE.test(n)) throw new Error(`"${n}" is not a valid server name.`);
        try {
          out[n] = withEnv(normalizeServerConfig(raw));
        } catch (err) {
          throw new Error(`Server "${n}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!Object.keys(out).length) throw new Error('The "mcpServers" block is empty.');
      return out;
    }
    const keys = Object.keys(obj);
    // A single named entry such as {"github": {"command": …}}
    if (keys.length === 1 && obj[keys[0]] && typeof obj[keys[0]] === 'object' && !('command' in obj) && !('url' in obj)) {
      if (!NAME_RE.test(keys[0])) throw new Error(`"${keys[0]}" is not a valid server name.`);
      return { [cleanName || keys[0]]: withEnv(normalizeServerConfig(obj[keys[0]])) };
    }
    return { [needName()]: withEnv(normalizeServerConfig(obj)) };
  }
  if (/^https?:\/\/\S+$/i.test(text)) return { [needName()]: { type: 'http', url: text } };
  const w = words(text);
  if (!w.length) throw new Error('Enter a command line, a URL or a JSON snippet.');
  return { [needName()]: withEnv({ type: 'stdio', command: w[0], args: w.length > 1 ? w.slice(1) : undefined }) };
}

/** Reads a project's .mcp.json. Entries that cannot be used are returned under `invalid` with the reason. */
export function readProjectServers(cwd: string): { servers: Record<string, McpServerConfig>; invalid: Record<string, string>; fileError?: string } {
  const file = path.join(cwd, PROJECT_FILE);
  const servers: Record<string, McpServerConfig> = {};
  const invalid: Record<string, string> = {};
  if (!fs.existsSync(file)) return { servers, invalid };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { servers, invalid, fileError: `${PROJECT_FILE} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return { servers, invalid, fileError: `${PROJECT_FILE} has no "mcpServers" object` };
  for (const [name, entry] of Object.entries(map as Record<string, unknown>)) {
    if (!NAME_RE.test(name)) {
      invalid[name.slice(0, 64)] = 'invalid server name';
      continue;
    }
    try {
      servers[name] = normalizeServerConfig(entry);
    } catch (err) {
      invalid[name] = err instanceof Error ? err.message : String(err);
    }
  }
  return { servers, invalid };
}

function writeProjectServers(cwd: string, update: (map: Record<string, unknown>) => void): void {
  const file = path.join(cwd, PROJECT_FILE);
  let root: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown; // throws on a malformed file: do not clobber it
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${PROJECT_FILE} is not a JSON object`);
    root = parsed as Record<string, unknown>;
  }
  const map = root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers) ? (root.mcpServers as Record<string, unknown>) : {};
  update(map);
  root.mcpServers = map;
  fs.writeFileSync(file, JSON.stringify(root, null, 2) + '\n');
}

const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '~/.local/bin', '~/.cargo/bin', '~/.bun/bin', '~/.deno/bin', '~/go/bin'];

let loginPathPromise: Promise<string> | null = null;

/**
 * PATH as the user's login shell sets it. An app launched from the Dock inherits only the system PATH, so
 * "npx"/"uvx" installed through Homebrew, nvm or uv would not be found without this.
 */
export function loginPath(): Promise<string> {
  loginPathPromise ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    const done = (raw: string) => {
      const line = raw.split('\n').reverse().find((l) => l.startsWith('__OC_PATH__'));
      const found = line ? line.slice('__OC_PATH__'.length).trim() : '';
      const parts = (found || process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
      for (const dir of COMMON_BIN_DIRS.map(expandHome)) if (!parts.includes(dir) && fs.existsSync(dir)) parts.push(dir);
      resolve(parts.join(':'));
    };
    try {
      execFile(shell, ['-ilc', 'echo "__OC_PATH__$PATH"'], { timeout: 6000, env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' } }, (_err, stdout) => done(String(stdout ?? '')));
    } catch {
      done('');
    }
  });
  return loginPathPromise;
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** JSON of a tool's arguments for the approval card, pretty and bounded. */
export function approvalDetail(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}, null, 2);
  } catch {
    text = String(args);
  }
  return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + '\n…' : text;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface CallResult {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

/** Maps a tool result's content blocks onto text (and the first image) for the model. */
export function contentToResult(res: CallResult): ToolResult {
  const texts: string[] = [];
  let image: string | undefined;
  const blocks = Array.isArray(res.content) ? (res.content as Record<string, unknown>[]) : [];
  for (const part of blocks) {
    switch (part.type) {
      case 'text':
        texts.push(String(part.text ?? ''));
        break;
      case 'image': {
        const mime = String(part.mimeType || 'image/png');
        const data = String(part.data ?? '');
        if (!image && /^image\//.test(mime)) image = `data:${mime};base64,${data}`;
        texts.push(`[image: ${mime}, ${formatBytes(Math.floor((data.length * 3) / 4))}${image?.endsWith(data) ? ', shown to the user' : ''}]`);
        break;
      }
      case 'audio':
        texts.push(`[audio: ${String(part.mimeType || 'audio')}, ${formatBytes(Math.floor((String(part.data ?? '').length * 3) / 4))}, not played]`);
        break;
      case 'resource': {
        const r = (part.resource ?? {}) as Record<string, unknown>;
        const uri = typeof r.uri === 'string' ? r.uri : '';
        if (typeof r.text === 'string') texts.push(uri ? `[resource ${uri}]\n${r.text}` : r.text);
        else texts.push(`[resource ${uri || '(no uri)'}: ${String(r.mimeType || 'binary')}, ${formatBytes(Math.floor((String(r.blob ?? '').length * 3) / 4))}]`);
        break;
      }
      case 'resource_link':
        texts.push(`[resource link: ${String(part.uri ?? '')}${part.name ? ` (${String(part.name)})` : ''}${part.description ? ` — ${String(part.description)}` : ''}]`);
        break;
      default:
        texts.push(`[${String(part.type ?? 'content')} block]`);
    }
  }
  if (!texts.length && res.structuredContent !== undefined) texts.push(JSON.stringify(res.structuredContent, null, 2));
  let content = texts.join('\n').trim();
  if (res.isError) content = `Error: ${content || 'the tool reported an error'}`;
  if (!content) content = image ? '[image returned]' : '(no output)';
  return image ? { content, image } : { content };
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const m = /spawn (\S+) ENOENT/.exec(err.message);
      return `Command not found${m ? `: ${m[1]}` : ''}. Check that it is installed and on your PATH.`;
    }
    return redactSecrets(err.message || String(err));
  }
  return redactSecrets(String(err));
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

/** A network failure or a lost session: what reconnecting can fix. */
export function isConnectionLoss(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } };
  if (e.code === 404) return true; // streamable HTTP: the server no longer knows the session (it restarted)
  const text = `${String(e.message ?? '')} ${String(e.cause?.code ?? '')} ${String(e.cause?.message ?? '')}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|socket hang up|other side closed|terminated|SSE stream disconnected|Failed to reconnect|Maximum reconnection attempts|SSE error/i.test(text);
}

function isTimeout(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

function formatMs(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/** A path segment from a name: no separators, no leading dots. */
function safeSegment(s: string): string {
  return s.replace(/[^\w.-]/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_';
}

/**
 * A text result over SPILL_OVER_CHARS: the whole text goes to a file (mode 0600, in a 0700 folder per session) and the
 * model gets its first SPILL_HEAD_CHARS and last SPILL_TAIL_CHARS, how much was left out and the file's path.
 * Images and other parts are unchanged.
 */
export function spillResult(result: ToolResult, o: { dir: string; sessionId?: string; server: string; tool: string }): ToolResult {
  const text = result.content;
  if (text.length <= SPILL_OVER_CHARS) return result;
  const head = text.slice(0, SPILL_HEAD_CHARS);
  const tail = text.slice(text.length - SPILL_TAIL_CHARS);
  const left = text.length - head.length - tail.length;
  let file: string | null = null;
  try {
    const dir = path.join(o.dir, safeSegment(o.sessionId || 'no-session'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(o.dir, 0o700);
    fs.chmodSync(dir, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    file = path.join(dir, `${stamp}-${safeSegment(o.server)}-${safeSegment(o.tool)}-${crypto.randomBytes(3).toString('hex')}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
  } catch (err) {
    console.warn('[mcp] could not save a large result:', errorText(err));
    file = null;
  }
  const n = (x: number) => x.toLocaleString('en-US');
  const where = file
    ? `The full result (${n(text.length)} characters) is saved in ${file}; read it in parts (read_file with offset and limit, or grep).`
    : `The result has ${n(text.length)} characters and could not be saved to a file.`;
  const content = `[${where} Shown here: the first ${n(head.length)} and the last ${n(tail.length)} characters.]\n${head}\n…[${n(left)} characters left out${file ? `; they are in ${file}` : ''}]…\n${tail}`;
  return { ...result, content };
}

/** Removes saved results older than `maxAgeMs`, and session folders left empty. */
export async function cleanOldResults(root: string, maxAgeMs = SPILL_MAX_AGE_MS, now = Date.now()): Promise<void> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    let kept = 0;
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = await fs.promises.lstat(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) await fs.promises.unlink(p);
        else kept++;
      } catch {
        kept++;
      }
    }
    if (!kept) await fs.promises.rmdir(dir).catch(() => undefined);
  }
}

type ConnectMode = 'initial' | 'reconnect' | 'respawn';
type ConnectOutcome = 'connected' | 'needs-auth' | 'failed' | 'stale';

export class McpManager extends EventEmitter {
  private entries = new Map<string, Entry>();
  private byFullName = new Map<string, ToolIndexEntry>();
  private clientInfo: { name: string; version: string };
  private reloading: Promise<void> | null = null;
  private closed = false;
  private readonly store: TokenStore;
  private readonly resultsDir: string;
  private readonly connectTimeout: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Calls waiting for a reconnecting server: checked on every change */
  private readonly settleWaiters = new Set<() => void>();

  constructor(private readonly opts: McpManagerOptions) {
    super();
    this.clientInfo = { name: 'Silo Harness', version: opts.version ?? '0.1.0' };
    this.store = opts.auth?.store ?? new MemoryTokenStore();
    this.resultsDir = opts.resultsDir ?? path.join(os.tmpdir(), 'silo-harness', 'mcp-results');
    this.connectTimeout = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    void cleanOldResults(this.resultsDir).catch(() => undefined);
  }

  list(): McpServerInfo[] {
    return [...this.entries.values()]
      .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1))
      .map((e) => this.infoOf(e));
  }

  private infoOf(e: Entry): McpServerInfo {
    const info: McpServerInfo = {
      name: e.name,
      scope: e.scope,
      transport: e.transport,
      target: targetOf(e.config),
      status: e.status,
      tools: e.status === 'connected' ? e.tools.map((t) => ({ ...t })) : [],
      config: structuredClone(e.config),
    };
    if (e.error) info.error = e.error;
    if (e.serverInfo) info.serverInfo = { ...e.serverInfo };
    if (e.status === 'connected' && e.hiddenTools.length) info.hiddenTools = [...e.hiddenTools];
    if (e.signedIn) info.signedIn = true;
    return info;
  }

  /** The config of a listed server, for callers that edit it (the IPC layer). */
  get(name: string, scope: McpScope): McpServerInfo | undefined {
    const e = this.entries.get(keyOf(scope, name));
    return e ? this.infoOf(e) : undefined;
  }

  private notify(): void {
    this.rebuildIndex();
    this.emit('servers', this.list());
    for (const check of [...this.settleWaiters]) check();
  }

  /** Names of project servers that wait for the user's OK (the renderer shows a notice). */
  blocked(): string[] {
    return [...this.entries.values()].filter((e) => e.status === 'blocked').map((e) => e.name);
  }

  /**
   * The `instructions` of each connected server that has tools to offer (what it tells a client about using it), at
   * most MAX_INSTRUCTIONS characters. Untrusted text from the server: the system prompt quotes it as such.
   */
  serverInstructions(): { server: string; scope: McpScope; instructions: string }[] {
    return [...this.entries.values()]
      .filter((e) => e.status === 'connected' && e.instructions && e.tools.length > 0)
      .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === 'project' ? -1 : 1))
      .map((e) => ({ server: e.name, scope: e.scope, instructions: e.instructions! }));
  }

  /** Re-reads the settings and the project file, connects new or changed servers and drops removed ones. */
  reload(): Promise<void> {
    if (this.reloading) return this.reloading.then(() => this.reload());
    this.reloading = this.doReload().finally(() => (this.reloading = null));
    return this.reloading;
  }

  private async doReload(): Promise<void> {
    if (this.closed) return;
    const cfg = this.opts.getConfig();
    const cwd = this.opts.cwd();
    const desired = new Map<string, { name: string; scope: McpScope; config: McpServerConfig; invalid?: string }>();
    for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
      if (!NAME_RE.test(name)) continue;
      try {
        desired.set(keyOf('user', name), { name, scope: 'user', config: normalizeServerConfig(raw) });
      } catch (err) {
        desired.set(keyOf('user', name), { name, scope: 'user', config: { command: '?' }, invalid: errorText(err) });
      }
    }
    const project = readProjectServers(cwd);
    if (project.fileError) console.warn('[mcp]', project.fileError);
    for (const [name, config] of Object.entries(project.servers)) desired.set(keyOf('project', name), { name, scope: 'project', config });
    for (const [name, reason] of Object.entries(project.invalid)) desired.set(keyOf('project', name), { name, scope: 'project', config: { command: '?' }, invalid: reason });

    const trusted = new Set(cfg.mcpTrusted?.[cwd] ?? []);
    const pending: Promise<unknown>[] = [];
    // Drop entries that are gone or changed.
    for (const [key, e] of [...this.entries]) {
      const want = desired.get(key);
      const signature = want ? JSON.stringify({ c: want.config, i: want.invalid ?? null, t: want.scope === 'project' ? trusted.has(want.name) : true }) : '';
      if (!want || signature !== e.signature) {
        this.entries.delete(key);
        pending.push(this.disconnect(e));
      }
    }
    // Add new ones.
    for (const [key, want] of desired) {
      if (this.entries.has(key)) continue;
      const signature = JSON.stringify({ c: want.config, i: want.invalid ?? null, t: want.scope === 'project' ? trusted.has(want.name) : true });
      const e: Entry = {
        name: want.name,
        scope: want.scope,
        config: want.config,
        signature,
        status: 'connecting',
        tools: [],
        sdkTools: [],
        client: null,
        transport: transportOf(want.config),
        stderr: [],
        generation: 0,
        hiddenTools: [],
      };
      this.entries.set(key, e);
      if (want.invalid) {
        e.status = 'error';
        e.error = `Invalid entry: ${want.invalid}`;
      } else if (want.config.disabled) {
        e.status = 'disabled';
      } else if (want.scope === 'project' && !trusted.has(want.name)) {
        e.status = 'blocked';
        e.error = `Found in ${PROJECT_FILE}. Enable it in Settings → MCP servers to let it run.`;
      } else {
        pending.push(this.connect(e));
      }
    }
    this.notify();
    await Promise.allSettled(pending);
  }

  /** The entry is still the one listed under its key (not replaced or removed) and the manager runs. */
  private isLive(e: Entry): boolean {
    return !this.closed && this.entries.get(keyOf(e.scope, e.name)) === e;
  }

  private isRemote(e: Entry): boolean {
    return transportOf(e.config) !== 'stdio';
  }

  /** The key of a server's record in the token store. */
  private authKey(e: Entry): string {
    return keyOf(e.scope, e.name);
  }

  private urlOf(e: Entry): string {
    return expandEnvRefs((e.config as Extract<McpServerConfig, { url: string }>).url);
  }

  /** OAuth applies to a remote server unless it sends its own Authorization header and has no "oauth" key. */
  private usesOAuth(e: Entry): boolean {
    if (!this.isRemote(e)) return false;
    const c = e.config as Extract<McpServerConfig, { url: string }>;
    if (c.oauth) return true;
    return !Object.keys(c.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
  }

  private isAuthFailure(err: unknown, e: Entry): boolean {
    if (err instanceof UnauthorizedError || err instanceof NeedsSignInError) return true;
    return this.usesOAuth(e) && !!err && typeof err === 'object' && (err as { code?: unknown }).code === 401;
  }

  private async refreshSignedIn(e: Entry): Promise<void> {
    if (!this.isRemote(e)) return;
    const now = await hasTokens(this.store, this.authKey(e), this.urlOf(e));
    if (now !== !!e.signedIn) {
      e.signedIn = now;
      if (this.isLive(e)) this.notify();
    }
  }

  private async connect(e: Entry, mode: ConnectMode = 'initial'): Promise<ConnectOutcome> {
    const gen = ++e.generation;
    const current = () => e.generation === gen && this.isLive(e);
    if (mode !== 'reconnect') {
      e.status = 'connecting';
      e.error = undefined;
    }
    if (mode === 'initial') {
      e.tools = [];
      e.sdkTools = [];
      e.hiddenTools = [];
    }
    e.stderr = [];
    e.respawn = false;
    this.notify();
    if (this.isRemote(e)) e.signedIn = await hasTokens(this.store, this.authKey(e), this.urlOf(e));
    if (!current()) return 'stale';
    let client = new Client(this.clientInfo, { capabilities: {} });
    const open: { transport: Transport | null } = { transport: null };
    try {
      const attempt = async (kind: 'stdio' | 'http' | 'sse') => {
        const transport = await this.makeTransport(e, kind);
        open.transport = transport;
        e.transport = kind;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No answer within ${Math.round(this.connectTimeout / 1000)} s`)), this.connectTimeout);
          timer.unref();
        });
        try {
          await Promise.race([client.connect(transport, { timeout: this.connectTimeout }), timeout]);
        } finally {
          clearTimeout(timer);
        }
      };
      const kind = transportOf(e.config);
      try {
        await attempt(kind);
      } catch (err) {
        // An "http" server that only speaks the older SSE transport answers the streamable POST with 4xx.
        if (kind === 'http' && !this.isAuthFailure(err, e) && !(err instanceof InsecureEndpointError) && /4\d\d|not found|method not allowed|failed to connect|unexpected content type/i.test(errorText(err))) {
          await open.transport?.close().catch(() => undefined);
          await client.close().catch(() => undefined);
          client = new Client(this.clientInfo, { capabilities: {} });
          await attempt('sse');
        } else throw err;
      }
      if (!current()) {
        await client.close().catch(() => undefined);
        return 'stale';
      }
      e.client = client;
      const v = client.getServerVersion();
      if (v) e.serverInfo = { name: String(v.name), version: String(v.version) };
      const instructions = client.getInstructions();
      e.instructions = typeof instructions === 'string' && instructions.trim() ? instructions.trim().slice(0, MAX_INSTRUCTIONS) : undefined;
      const mine = () => current() && e.client === client;
      client.onclose = () => {
        if (mine()) this.onDropped(e, 'Connection closed');
      };
      client.onerror = (err) => {
        if (!mine()) return; // a client already given up (closing it aborts its streams)
        const text = errorText(err);
        console.warn(`[mcp:${e.name}]`, text);
        // The streamable HTTP transport reports a lost stream here rather than closing.
        if (mine() && e.transport !== 'stdio' && e.status === 'connected' && isConnectionLoss(err)) this.onDropped(e, text);
      };
      try {
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          if (!current()) return;
          await this.refreshTools(e, gen).catch((err: unknown) => console.warn(`[mcp:${e.name}] tool list refresh failed:`, errorText(err)));
        });
      } catch {
        /* a server without the capability */
      }
      await this.refreshTools(e, gen);
      if (!current()) return 'stale';
      e.status = 'connected';
      e.error = undefined;
      e.lastError = undefined;
      this.notify();
      return 'connected';
    } catch (err) {
      if (!current()) {
        await client.close().catch(() => undefined);
        return 'stale';
      }
      // A process that exits at once closes the connection before its stderr has been read: give it a moment.
      if (e.transport === 'stdio') await new Promise((r) => setTimeout(r, 200));
      if (!current()) return 'stale';
      e.client = null;
      await client.close().catch(() => undefined);
      if (this.isRemote(e) && this.isAuthFailure(err, e)) {
        // Nothing more until the user clicks "Sign in": no browser, no retry loop.
        e.status = 'needs-auth';
        e.error = undefined;
        e.tools = [];
        e.sdkTools = [];
        e.hiddenTools = [];
        e.signedIn = await hasTokens(this.store, this.authKey(e), this.urlOf(e));
        this.notify();
        return 'needs-auth';
      }
      let text = errorText(err);
      if (/connection closed/i.test(text)) text = e.transport === 'stdio' ? 'The server exited right after starting.' : 'The server closed the connection.';
      text += e.stderr.length ? `\n${e.stderr.slice(-4).join('\n')}` : '';
      e.lastError = text;
      if (mode === 'reconnect') return 'failed'; // the loop decides; the status stays "reconnecting"
      e.status = 'error';
      e.error = text;
      e.tools = [];
      e.sdkTools = [];
      e.hiddenTools = [];
      this.notify();
      return 'failed';
    }
  }

  /** A connected server's transport went away: a stdio server waits for its next call, a remote one reconnects. */
  private onDropped(e: Entry, reason: string): void {
    if (e.status !== 'connected') return;
    if (e.transport === 'stdio') {
      e.client = null;
      e.status = 'error';
      e.error = `The server exited${e.stderr.length ? `: ${e.stderr.slice(-3).join(' · ')}` : ''}. It restarts on the next tool call.`;
      e.respawn = true; // its tools stay offered; the next call starts it again, once
      this.notify();
      return;
    }
    this.scheduleReconnect(e, reason);
  }

  /** Reconnects a remote server: up to `tries` attempts, waiting baseMs, doubling up to maxMs, before each. */
  private scheduleReconnect(e: Entry, reason: string): void {
    if (this.closed || e.loop || !this.isLive(e) || !this.isRemote(e)) return;
    const loop = { cancelled: false };
    e.loop = loop;
    const old = e.client;
    e.client = null;
    e.generation++; // the old client's callbacks no longer count
    void old?.close().catch(() => undefined);
    e.status = 'reconnecting';
    e.error = `Connection lost: ${firstLine(reason)}`;
    this.notify();
    const { tries = 5, baseMs = 1000, maxMs = 30_000 } = this.opts.reconnect ?? {};
    void (async () => {
      let last = firstLine(reason);
      for (let i = 0; i < tries; i++) {
        await this.sleep(Math.min(baseMs * 2 ** i, maxMs));
        if (loop.cancelled || !this.isLive(e)) return;
        const outcome = await this.connect(e, 'reconnect');
        if (loop.cancelled) return;
        if (outcome !== 'failed') {
          e.loop = null;
          return;
        }
        last = firstLine(e.lastError ?? last);
      }
      if (loop.cancelled || !this.isLive(e)) return;
      e.loop = null;
      e.status = 'error';
      e.error = `Could not reconnect after ${tries} tries: ${last}`;
      e.tools = [];
      e.sdkTools = [];
      e.hiddenTools = [];
      this.notify();
    })();
  }

  private makeTransport(e: Entry, kind: 'stdio' | 'http' | 'sse'): Promise<Transport> | Transport {
    const c = e.config;
    if (kind === 'stdio') return this.makeStdio(e);
    const h = c as Extract<McpServerConfig, { url: string }>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = expandEnvRefs(v);
    const url = new URL(expandEnvRefs(h.url));
    const authProvider = this.usesOAuth(e)
      ? new McpOAuthProvider({ key: this.authKey(e), serverUrl: this.urlOf(e), store: this.store, oauth: h.oauth, onChange: () => void this.refreshSignedIn(e) })
      : undefined;
    const fetchFn = guardedFetch(url);
    if (kind === 'sse') return new SSEClientTransport(url, { requestInit: { headers }, authProvider, fetch: fetchFn });
    return new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider, fetch: fetchFn });
  }

  private async makeStdio(e: Entry): Promise<Transport> {
    const s = e.config as Extract<McpServerConfig, { command: string }>;
    const envExtra: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env ?? {})) envExtra[k] = expandEnvRefs(v);
    const base: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') base[k] = v;
    base.PATH = await loginPath();
    const cwd = s.cwd ? path.resolve(this.opts.cwd(), expandHome(expandEnvRefs(s.cwd))) : this.opts.cwd();
    const t = new StdioClientTransport({
      command: expandHome(expandEnvRefs(s.command)),
      args: (s.args ?? []).map((a) => expandHome(expandEnvRefs(a))),
      env: { ...base, ...envExtra },
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      stderr: 'pipe',
    });
    // stderr exists once the process is spawned (inside connect → start); attach on the next tick.
    setImmediate(() => {
      const stream = t.stderr;
      if (!stream) return;
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
          if (!clean) continue;
          e.stderr.push(clean.slice(0, 300));
          if (e.stderr.length > STDERR_LINES) e.stderr.shift();
        }
      });
    });
    return t;
  }

  private async refreshTools(e: Entry, gen: number): Promise<void> {
    const client = e.client ?? null;
    if (!client) return;
    const tools: SdkTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.connectTimeout });
      tools.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    if (e.generation !== gen) return;
    const allow = e.config.enabledTools;
    const deny = new Set(e.config.disabledTools ?? []);
    const kept = tools.filter((t) => (!allow || allow.includes(t.name)) && !deny.has(t.name));
    e.hiddenTools = tools.filter((t) => !kept.includes(t)).map((t) => t.name);
    e.sdkTools = kept;
    e.tools = kept.map((t) => ({
      name: t.name,
      fullName: '', // assigned by rebuildIndex (needs the global view for collisions)
      description: String(t.description ?? '').trim(),
      readOnly: t.annotations?.readOnlyHint === true,
      destructive: t.annotations?.destructiveHint === true,
    }));
    this.notify();
  }

  /**
   * Whether a server's tools are offered to the model: connected, reconnecting (a call waits), an exited stdio server
   * (the next call starts it again), or one being started again with its tools kept.
   */
  private offered(e: Entry): boolean {
    return e.status === 'connected' || e.status === 'reconnecting' || (e.status === 'error' && !!e.respawn) || (e.status === 'connecting' && e.tools.length > 0);
  }

  /** Assigns the model-facing names (mcp__server__tool, unique and at most 64 characters) and indexes them. */
  private rebuildIndex(): void {
    this.byFullName.clear();
    for (const e of this.entries.values()) {
      if (!this.offered(e) && e.status !== 'connecting') continue;
      e.tools.forEach((info, i) => {
        let base = `mcp__${sanitizeName(e.name)}__${sanitizeName(info.name)}`;
        if (base.length > MAX_TOOL_NAME) base = base.slice(0, MAX_TOOL_NAME);
        let full = base;
        for (let n = 2; this.byFullName.has(full); n++) {
          const suffix = `_${n}`;
          full = base.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
        }
        info.fullName = full;
        this.byFullName.set(full, { entry: e, tool: e.sdkTools[i], info });
      });
    }
  }

  private async disconnect(e: Entry): Promise<void> {
    e.generation++;
    if (e.loop) e.loop.cancelled = true;
    e.loop = null;
    if (e.signIn) e.signIn.abort();
    e.signIn = null;
    e.respawn = false;
    const client = e.client;
    e.client = null;
    e.tools = [];
    e.sdkTools = [];
    e.hiddenTools = [];
    if (client) await client.close().catch(() => undefined);
  }

  /** What the model gets: one Tool per offered server tool, approval included. */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const { entry, tool, info } of this.byFullName.values()) {
      if (!this.offered(entry)) continue;
      const ref: McpToolRef = { server: entry.name, scope: entry.scope, tool: tool.name, readOnly: info.readOnly, destructive: info.destructive };
      const description = `[${entry.name}] ${info.description || tool.name}`.slice(0, 1024);
      const parameters = (tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }) as Record<string, unknown>;
      out.push({
        name: info.fullName,
        description,
        parameters,
        mcp: ref,
        run: async (args, ctx) => {
          const ok = await ctx.approve(info.fullName, approvalDetail(args));
          if (!ok.ok) return { content: ok.message };
          return this.call(info.fullName, args, ctx.signal, ctx.sessionId);
        },
      });
    }
    return out;
  }

  /** The server and annotations behind a model-facing tool name. */
  lookup(fullName: string): McpToolRef | undefined {
    const hit = this.byFullName.get(fullName);
    if (!hit) return undefined;
    return { server: hit.entry.name, scope: hit.entry.scope, tool: hit.tool.name, readOnly: hit.info.readOnly, destructive: hit.info.destructive };
  }

  /** Waits while a server connects or reconnects, up to `ms`; rejects on abort or when the time is up. */
  private waitSettled(e: Entry, ms: number, signal?: AbortSignal): Promise<void> {
    const busy = () => this.isLive(e) && (e.status === 'reconnecting' || e.status === 'connecting');
    if (!busy()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err?: Error) => {
        clearTimeout(timer);
        this.settleWaiters.delete(check);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };
      const check = () => {
        if (!busy()) done();
      };
      const onAbort = () => done(new Error('The call was aborted.'));
      const timer = setTimeout(() => done(new Error(`MCP server "${e.name}" is reconnecting and did not come back within ${formatMs(ms)}.`)), ms);
      this.settleWaiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notConnectedText(e: Entry): string {
    if (e.status === 'needs-auth' || e.status === 'authorizing') return `MCP server "${e.name}" needs sign-in. The user can sign in under Settings → MCP.`;
    return `MCP server "${e.name}" is not connected (${firstLine(e.error ?? e.status)})`;
  }

  async call(fullName: string, args: unknown, signal?: AbortSignal, sessionId?: string): Promise<ToolResult> {
    const hit = this.byFullName.get(fullName);
    if (!hit) throw new Error(`Unknown MCP tool ${fullName}`);
    const e = hit.entry;
    const toolName = hit.tool.name;
    if (e.status === 'reconnecting' || e.status === 'connecting') await this.waitSettled(e, this.connectTimeout, signal);
    else if (e.respawn && !e.client && this.isLive(e)) await this.connect(e, 'respawn'); // once: connect clears the flag
    const client = e.client;
    if (!client || e.status !== 'connected') throw new Error(this.notConnectedText(e));
    if (!e.sdkTools.some((t) => t.name === toolName)) throw new Error(`MCP server "${e.name}" no longer offers "${toolName}".`);
    const params = { name: toolName, arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown> };
    const timeout = e.config.timeout ?? CALL_TIMEOUT_MS;
    let res: CallResult;
    try {
      // onprogress asks the server for progress notifications; each one restarts the timeout.
      res = (await client.callTool(params, undefined, { timeout, resetTimeoutOnProgress: true, maxTotalTimeout: Math.max(MAX_TOTAL_CALL_MS, timeout), signal, onprogress: () => undefined })) as CallResult;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (isTimeout(err)) throw new Error(`"${toolName}" on MCP server "${e.name}" did not finish in time (timeout ${formatMs(timeout)}).`);
      if (this.isRemote(e) && this.isAuthFailure(err, e)) {
        this.markNeedsAuth(e);
        throw new Error(this.notConnectedText(e));
      }
      const closed = err instanceof McpError && err.code === ErrorCode.ConnectionClosed;
      if (this.isRemote(e) && (closed || isConnectionLoss(err))) {
        // The transport's own error report may have started the reconnection already (and closed this client).
        if (e.client === client) this.scheduleReconnect(e, errorText(err));
        if ((e.status as McpStatus) === 'reconnecting') throw new Error(`Lost the connection to MCP server "${e.name}"; it is reconnecting. Try the call again in a moment.`);
      }
      if (closed) throw new Error(`MCP server "${e.name}" closed the connection during the call.`);
      throw new Error(errorText(err));
    }
    return spillResult(contentToResult(res), { dir: this.resultsDir, sessionId, server: e.name, tool: toolName });
  }

  /** A remote server's tokens stopped working (and refreshing them failed): back to "Sign in", nothing automatic. */
  private markNeedsAuth(e: Entry): void {
    if (!this.isLive(e)) return;
    const client = e.client;
    e.client = null;
    e.generation++;
    if (e.loop) e.loop.cancelled = true;
    e.loop = null;
    void client?.close().catch(() => undefined);
    e.status = 'needs-auth';
    e.error = undefined;
    e.tools = [];
    e.sdkTools = [];
    e.hiddenTools = [];
    this.notify();
    void this.refreshSignedIn(e);
  }

  /** One line per connected server for the system prompt, or '' when there is none. */
  describe(): string {
    const lines: string[] = [];
    for (const e of this.list()) {
      if (e.status !== 'connected' || !e.tools.length) continue;
      const names = e.tools.map((t) => t.name);
      const shown = names.slice(0, 15).join(', ') + (names.length > 15 ? `, … (${names.length} tools)` : '');
      lines.push(`- ${e.name} (${e.tools.length} tool${e.tools.length === 1 ? '' : 's'}): ${shown}`);
    }
    return lines.join('\n');
  }

  /** Adds servers from what the user typed, persists them and connects. Returns the new list. */
  async add(name: string, spec: string, scope: McpScope, env?: Record<string, string>): Promise<McpServerInfo[]> {
    const configs = parseServerSpec(name, spec, env);
    const cfg = this.opts.getConfig();
    const cwd = this.opts.cwd();
    const existing = scope === 'user' ? Object.keys(cfg.mcpServers ?? {}) : Object.keys(readProjectServers(cwd).servers);
    for (const n of Object.keys(configs)) if (existing.includes(n)) throw new Error(`A ${scope === 'user' ? 'server' : 'project server'} named "${n}" already exists. Remove it first or pick another name.`);
    if (scope === 'user') {
      this.opts.saveConfig({ mcpServers: { ...(cfg.mcpServers ?? {}), ...configs } });
    } else {
      writeProjectServers(cwd, (map) => {
        for (const [n, c] of Object.entries(configs)) map[n] = stripUndefined(c);
      });
      // The user added it themselves: no separate "enable" step.
      const trusted = new Set(cfg.mcpTrusted?.[cwd] ?? []);
      for (const n of Object.keys(configs)) trusted.add(n);
      this.opts.saveConfig({ mcpTrusted: { ...(cfg.mcpTrusted ?? {}), [cwd]: [...trusted] } });
    }
    await this.reload();
    return this.list();
  }

  async remove(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const cfg = this.opts.getConfig();
    if (scope === 'user') {
      if (!cfg.mcpServers?.[name]) throw new Error(`No server named "${name}".`);
      const next = { ...cfg.mcpServers };
      delete next[name];
      this.opts.saveConfig({ mcpServers: next });
    } else {
      const cwd = this.opts.cwd();
      writeProjectServers(cwd, (map) => {
        if (!(name in map)) throw new Error(`No project server named "${name}".`);
        delete map[name];
      });
      const trusted = (cfg.mcpTrusted?.[cwd] ?? []).filter((n) => n !== name);
      this.opts.saveConfig({ mcpTrusted: { ...(cfg.mcpTrusted ?? {}), [cwd]: trusted } });
    }
    await this.reload();
    return this.list();
  }

  /** User servers: the disabled flag. Project servers: trusted for this working directory, or not. */
  async setEnabled(name: string, scope: McpScope, enabled: boolean): Promise<McpServerInfo[]> {
    const cfg = this.opts.getConfig();
    if (scope === 'user') {
      const c = cfg.mcpServers?.[name];
      if (!c) throw new Error(`No server named "${name}".`);
      const next = { ...c } as McpServerConfig & { disabled?: boolean };
      if (enabled) delete next.disabled;
      else next.disabled = true;
      this.opts.saveConfig({ mcpServers: { ...cfg.mcpServers, [name]: next } });
    } else {
      const cwd = this.opts.cwd();
      if (!this.entries.has(keyOf('project', name))) throw new Error(`No project server named "${name}" in ${PROJECT_FILE}.`);
      const trusted = new Set(cfg.mcpTrusted?.[cwd] ?? []);
      if (enabled) trusted.add(name);
      else trusted.delete(name);
      this.opts.saveConfig({ mcpTrusted: { ...(cfg.mcpTrusted ?? {}), [cwd]: [...trusted] } });
    }
    await this.reload();
    return this.list();
  }

  async reconnect(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const e = this.entries.get(keyOf(scope, name));
    if (!e) throw new Error(`No ${scope} server named "${name}".`);
    if (e.status === 'disabled' || e.status === 'blocked') return this.list();
    await this.disconnect(e);
    await this.connect(e);
    return this.list();
  }

  private remoteEntry(name: string, scope: McpScope): Entry {
    const e = this.entries.get(keyOf(scope, name));
    if (!e) throw new Error(`No ${scope} server named "${name}".`);
    if (!this.isRemote(e)) throw new Error(`"${name}" is not a remote server: sign-in is for servers with a URL.`);
    return e;
  }

  /**
   * The user's sign-in (OAuth) for a remote server: opens the authorization page in the browser and waits for its
   * return on 127.0.0.1. The promise settles when sign-in ends (signed in and connected, failed, cancelled or timed
   * out); the status is "authorizing" meanwhile. Only ever started by the user.
   */
  async signIn(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const e = this.remoteEntry(name, scope);
    if (e.status === 'disabled' || e.status === 'blocked') throw new Error(`Turn "${name}" on first.`);
    if (e.signIn) return this.list();
    const open = this.opts.auth?.openExternal;
    if (!open) throw new Error('Sign-in is not available in this build.');
    if (e.loop) e.loop.cancelled = true;
    e.loop = null;
    const old = e.client;
    e.client = null;
    e.generation++;
    void old?.close().catch(() => undefined);
    const ctl = new AbortController();
    e.signIn = ctl;
    e.status = 'authorizing';
    e.error = undefined;
    e.tools = [];
    e.sdkTools = [];
    e.hiddenTools = [];
    this.notify();
    const url = this.urlOf(e);
    try {
      await runSignIn({
        key: this.authKey(e),
        serverUrl: url,
        store: this.store,
        oauth: (e.config as Extract<McpServerConfig, { url: string }>).oauth,
        open,
        fetchFn: guardedFetch(new URL(url)),
        signal: ctl.signal,
        timeoutMs: this.opts.auth?.signInTimeoutMs,
      });
      if (e.signIn !== ctl || !this.isLive(e)) return this.list();
      e.signIn = null;
      await this.connect(e);
    } catch (err) {
      if (e.signIn !== ctl || !this.isLive(e)) return this.list();
      e.signIn = null;
      e.status = 'needs-auth';
      e.error = ctl.signal.aborted ? undefined : errorText(err);
      e.signedIn = await hasTokens(this.store, this.authKey(e), url);
      this.notify();
    }
    return this.list();
  }

  /** Stops a sign-in that waits for the browser (the callback listener closes). */
  async cancelSignIn(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const e = this.remoteEntry(name, scope);
    const ctl = e.signIn;
    if (!ctl) return this.list();
    e.signIn = null;
    ctl.abort();
    e.status = 'needs-auth';
    e.error = undefined;
    this.notify();
    return this.list();
  }

  /** Deletes the server's tokens and client registration, then connects without them. */
  async signOut(name: string, scope: McpScope): Promise<McpServerInfo[]> {
    const e = this.remoteEntry(name, scope);
    await this.disconnect(e);
    await this.store.delete(this.authKey(e));
    e.signedIn = false;
    if (e.status === 'disabled' || e.status === 'blocked') {
      this.notify();
      return this.list();
    }
    await this.connect(e);
    return this.list();
  }

  /** Stops every server (app quit). */
  async close(): Promise<void> {
    this.closed = true;
    const all = [...this.entries.values()];
    this.entries.clear();
    this.byFullName.clear();
    for (const check of [...this.settleWaiters]) check();
    await Promise.allSettled(all.map((e) => this.disconnect(e)));
  }
}

function stripUndefined<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}
