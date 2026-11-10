// A quiet check for a newer release: about 30 s after start and then once a day while the app runs, GET the latest
// release of BrandeisPatrick/silo-harness from GitHub's API (no auth, 10 s, failures silent), and when its version
// is newer than the running one, tell the window, which shows one dismissible line with a Download button that opens
// the release page in the default browser. Nothing is downloaded or installed (the build is ad-hoc signed), and
// there is no system notification. Off with Settings → General → Check for updates (AppConfig.checkForUpdates), and
// skipped in development and tests (an unpackaged app) unless SILO_HARNESS_CHECK_UPDATES=1.
//
// The logic (parse, compare, schedule) is free of Electron: UpdateChecker takes its fetch and clock, so tests drive
// it headless. setupUpdates is the wiring: one line in index.ts.

import type { App } from './app';
import type { UpdateState } from '../shared/updates';
import { deadline, request } from './web/fetch';

export const RELEASES_API = 'https://api.github.com/repos/BrandeisPatrick/silo-harness/releases/latest';
const RELEASE_PAGE_PREFIX = 'https://github.com/BrandeisPatrick/silo-harness/releases/';
export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
export const CHECK_TIMEOUT_MS = 10_000;

// ---------- Versions ----------

interface Version {
  core: [number, number, number];
  pre: string[];
}

/** "v0.14.0", "0.14.0-beta.2" → its parts; null when it is not a version. */
export function parseVersion(s: string): Version | null {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver order: negative when a < b, 0 when equal, positive when a > b (a prerelease sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The release GitHub's API describes, when it is a real, newer release: not a draft or a prerelease, its tag a
 * version above `current`, its page on the project's releases. null otherwise.
 */
export function newerRelease(json: unknown, current: string): { version: string; url: string } | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const v = parseVersion(tag);
  if (!v || v.pre.length) return null;
  if (!parseVersion(current) || compareVersions(tag, current) <= 0) return null;
  const version = tag.trim().replace(/^v/, '');
  const page = typeof r.html_url === 'string' && r.html_url.startsWith(RELEASE_PAGE_PREFIX) ? r.html_url : `${RELEASE_PAGE_PREFIX}tag/${encodeURIComponent(tag.trim())}`;
  return { version, url: page };
}

// ---------- The schedule ----------

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CheckerOptions {
  currentVersion: string;
  /** GET the API: the parsed JSON, or a rejection (any failure is silent) */
  fetchJson(url: string): Promise<unknown>;
  /** The switch in Settings */
  enabled(): boolean;
  clock?: Clock;
  onChange?(state: UpdateState): void;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class UpdateChecker {
  private timer: unknown = null;
  private current: UpdateState = { available: null };
  private running = false;
  private readonly clock: Clock;

  constructor(private readonly opts: CheckerOptions) {
    this.clock = opts.clock ?? realClock;
  }

  state(): UpdateState {
    return this.current;
  }

  /** The first check in FIRST_CHECK_MS, then one every CHECK_EVERY_MS. */
  start(): void {
    this.schedule(FIRST_CHECK_MS);
  }

  stop(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.stop();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.check().finally(() => {
        if (this.timer === null) this.schedule(CHECK_EVERY_MS);
      });
    }, ms);
  }

  /** One check now (when enabled). Never throws. */
  async check(): Promise<UpdateState> {
    if (!this.opts.enabled()) {
      this.set({ available: null });
      return this.current;
    }
    if (this.running) return this.current;
    this.running = true;
    try {
      const json = await this.opts.fetchJson(RELEASES_API);
      // The setting may have been turned off while the request ran
      this.set({ available: this.opts.enabled() ? newerRelease(json, this.opts.currentVersion) : null });
    } catch {
      /* silent: the next check tries again */
    } finally {
      this.running = false;
    }
    return this.current;
  }

  /** The switch was turned off: forget what was found (on again: the next scheduled check finds it). */
  disabled(): void {
    this.set({ available: null });
  }

  private set(next: UpdateState): void {
    const same = (this.current.available?.version ?? null) === (next.available?.version ?? null) && (this.current.available?.url ?? null) === (next.available?.url ?? null);
    this.current = next;
    if (!same) this.opts.onChange?.(next);
  }
}

// ---------- The wiring ----------

/** GET the API through the checked fetcher, as `SiloHarness`, within 10 s. */
async function githubJson(url: string): Promise<unknown> {
  const dl = deadline(CHECK_TIMEOUT_MS);
  try {
    const res = await request(new URL(url), { signal: dl.signal, headers: { 'User-Agent': 'SiloHarness', Accept: 'application/vnd.github+json' }, hooks: { maxBytes: 1024 * 1024 } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.body.toString('utf8'));
  } finally {
    dl.clear();
  }
}

/** Starts the check in a packaged app (or with SILO_HARNESS_CHECK_UPDATES=1) and serves updates.state and updates.open. */
export function setupUpdates(app: App): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron');
  const forced = process.env.SILO_HARNESS_CHECK_UPDATES === '1';
  const active = forced || (electron.app.isPackaged && !process.env.SILO_HARNESS_LIVE_TEST);
  const checker = new UpdateChecker({
    currentVersion: electron.app.getVersion(),
    fetchJson: githubJson,
    enabled: () => app.config().checkForUpdates !== false,
    onChange: (s) => app.push('updates:changed', s),
  });
  app.rpc.handle('updates.state', () => checker.state());
  app.rpc.handle('updates.open', () => {
    const url = checker.state().available?.url;
    if (url && url.startsWith(RELEASE_PAGE_PREFIX)) void electron.shell.openExternal(url);
  });
  if (!active) return;
  checker.start();
  app.onConfig((next, prev) => {
    if (next.checkForUpdates === false && prev.checkForUpdates !== false) checker.disabled();
  });
  app.onQuit(() => checker.stop());
}
