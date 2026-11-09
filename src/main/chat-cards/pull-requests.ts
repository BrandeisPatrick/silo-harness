// A pull request's card data from the GitHub CLI: `gh pr view <url> --json …`, mapped to PullRequestInfo. The URL
// check, the field list and the mapping are pure (test/chat-cards.js runs them headless); PullRequestLookup runs gh
// through an exec function it is given, keeps each answer for a minute and runs at most a few gh calls at once.
// No Electron here.

import type { PullRequestChecks, PullRequestInfo, PullRequestRef, PullRequestState } from '../../shared/chat-cards';

/** A GitHub pull request URL: owner (letters, digits, hyphens), repository (also . and _), number. */
const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})(?:[/?#][^\s]*)?$/i;

/** The pull request a URL names, with its canonical URL, or null for anything else. */
export function parsePullRequestUrl(url: unknown): PullRequestRef | null {
  const m = PR_URL.exec(String(url ?? '').trim());
  if (!m) return null;
  const [, owner, repo, num] = m;
  if (repo === '.' || repo === '..' || /\.git$/i.test(repo)) return null;
  const number = Number(num);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}

/** The fields the card asks gh for. */
export const GH_FIELDS = [
  'number',
  'title',
  'state',
  'isDraft',
  'author',
  'createdAt',
  'mergedAt',
  'closedAt',
  'additions',
  'deletions',
  'changedFiles',
  'statusCheckRollup',
  'reviewDecision',
  'mergeable',
] as const;

/** The arguments of the gh call for a pull request. */
export function ghArgs(ref: PullRequestRef): string[] {
  return ['pr', 'view', ref.url, '--json', GH_FIELDS.join(',')];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
const time = (v: unknown): number | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  const t = Date.parse(v);
  // gh prints "0001-01-01T00:00:00Z" for a date that is not set
  return Number.isFinite(t) && t > 0 ? t : undefined;
};

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

/** The checks of a statusCheckRollup (check runs and commit statuses), summed up; null when there are none. */
export function checksOf(rollup: unknown): PullRequestChecks | null {
  if (!Array.isArray(rollup)) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of rollup) {
    if (!isObj(c)) continue;
    // A check run has status and conclusion; a commit status has state
    const status = String(c.status ?? '').toUpperCase();
    const outcome = String(c.conclusion ?? c.state ?? '').toUpperCase();
    if (c.status !== undefined && status !== 'COMPLETED') pending++;
    else if (PASSED.has(outcome)) passed++;
    else if (FAILED.has(outcome)) failed++;
    else pending++; // PENDING, EXPECTED, or a run that finished without a verdict yet
  }
  const total = passed + failed + pending;
  if (!total) return null;
  return { state: failed ? 'failing' : pending ? 'pending' : 'passing', total, passed, failed, pending };
}

/** Maps gh's JSON for a pull request to the card's data. */
export function pullRequestFromGh(json: unknown, ref: PullRequestRef, now: number): PullRequestInfo {
  if (!isObj(json)) return { ref, found: false, error: 'gh gave no pull request', fetchedAt: now };
  const raw = String(json.state ?? '').toUpperCase();
  const state: PullRequestState = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : json.isDraft === true ? 'draft' : 'open';
  const at = state === 'merged' ? time(json.mergedAt) ?? time(json.closedAt) : state === 'closed' ? time(json.closedAt) : time(json.createdAt);
  const author = isObj(json.author) && typeof json.author.login === 'string' ? json.author.login : undefined;
  const decision = String(json.reviewDecision ?? '').toUpperCase();
  const review = decision === 'APPROVED' ? 'approved' : decision === 'CHANGES_REQUESTED' ? 'changes' : decision === 'REVIEW_REQUIRED' ? 'required' : null;
  const info: PullRequestInfo = {
    ref,
    found: true,
    title: typeof json.title === 'string' ? json.title.replace(/\s+/g, ' ').trim() : undefined,
    state,
    author,
    at,
    files: num(json.changedFiles),
    additions: num(json.additions),
    deletions: num(json.deletions),
    checks: checksOf(json.statusCheckRollup),
    review,
    conflicts: String(json.mergeable ?? '').toUpperCase() === 'CONFLICTING' && (state === 'open' || state === 'draft'),
    fetchedAt: now,
  };
  for (const k of Object.keys(info) as (keyof PullRequestInfo)[]) if (info[k] === undefined) delete info[k];
  return info;
}

/** What a failed gh call says, in a few words. */
export function ghError(err: unknown): string {
  const e = (isObj(err) ? err : {}) as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; message?: unknown };
  if (e.code === 'ENOENT') return 'gh is not installed';
  if (e.killed || e.signal === 'SIGTERM') return 'gh took too long';
  const text = `${String(e.stderr ?? '')}\n${String(e.message ?? '')}`;
  if (/gh auth login|not logged in|authentication|GH_TOKEN/i.test(text)) return 'gh is not signed in';
  if (/could not resolve to a pullrequest|not found|404/i.test(text)) return 'Pull request not found';
  if (/could not resolve host|network|timed? ?out|ECONNRESET|ENOTFOUND/i.test(text)) return 'GitHub could not be reached';
  const line = String(e.stderr ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 160) : 'gh failed';
}

/** Runs gh with these arguments; resolves to its stdout, rejects like child_process.execFile. */
export type GhExec = (args: string[]) => Promise<string>;

export interface LookupOptions {
  exec: GhExec;
  now?: () => number;
  /** How long an answer is kept (default a minute) */
  ttlMs?: number;
  /** gh calls at once (default 3) */
  concurrency?: number;
}

/** gh lookups with a cache: one call per pull request at a time, an answer kept for a minute, a few calls at once. */
export class PullRequestLookup {
  private readonly cache = new Map<string, PullRequestInfo>();
  private readonly inflight = new Map<string, Promise<PullRequestInfo>>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly concurrency: number;

  constructor(private readonly opts: LookupOptions) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.ttlMs ?? 60_000;
    this.concurrency = Math.max(1, opts.concurrency ?? 3);
  }

  /** The card data for a pull request URL; throws for a URL that is not one. */
  get(url: string): Promise<PullRequestInfo> {
    const ref = parsePullRequestUrl(url);
    if (!ref) return Promise.reject(new Error('Not a GitHub pull request URL'));
    const kept = this.cache.get(ref.url);
    if (kept && this.now() - kept.fetchedAt < this.ttl) return Promise.resolve(kept);
    const going = this.inflight.get(ref.url);
    if (going) return going;
    const p = this.slot(() => this.fetch(ref)).finally(() => this.inflight.delete(ref.url));
    this.inflight.set(ref.url, p);
    return p;
  }

  /** Forgets every kept answer (tests). */
  clear(): void {
    this.cache.clear();
  }

  private async fetch(ref: PullRequestRef): Promise<PullRequestInfo> {
    let info: PullRequestInfo;
    try {
      const out = await this.opts.exec(ghArgs(ref));
      let json: unknown;
      try {
        json = JSON.parse(out);
      } catch {
        json = null;
      }
      info = pullRequestFromGh(json, ref, this.now());
    } catch (err) {
      info = { ref, found: false, error: ghError(err), fetchedAt: this.now() };
    }
    this.cache.set(ref.url, info);
    return info;
  }

  private slot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < this.concurrency) start();
      else this.queue.push(start);
    });
  }
}
