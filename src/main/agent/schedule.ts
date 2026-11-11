// The order a reply's tool calls run in. A run of consecutive calls that are safe to share (reads: the agent decides,
// agent.ts shareable) runs together, at most `limit` at a time; any other call is a barrier: nothing before it is
// still running when it starts, and nothing after it starts until it ends. Each call is prepared (parsed, its
// PreToolUse hook run) in call order and judged on its final arguments; results are committed in call order whatever
// order they finish in. A limit of 1 makes every call a barrier: exactly the old one-at-a-time loop.
// Pure: no Electron, no agent; the agent passes the steps in (test/schedule.js drives it with fakes).

/** toolConcurrency: the default, and its bounds */
export const DEFAULT_LIMIT = 4;
export const MAX_LIMIT = 10;

/** The limit from a setting: a whole number from 1 to MAX_LIMIT, else the default. */
export function concurrencyLimit(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(MAX_LIMIT, v) : DEFAULT_LIMIT;
}

/** How the calls group, when whether each may share is known up front: a run of shared calls is one group, any other call a group of its own. */
export function planGroups(share: readonly boolean[], limit: number): number[][] {
  const groups: number[][] = [];
  let run: number[] | null = null;
  share.forEach((ok, i) => {
    if (ok && limit > 1) {
      if (!run) groups.push((run = []));
      run.push(i);
    } else {
      run = null;
      groups.push([i]);
    }
  });
  return groups;
}

/** What preparing a call gave: a result already (an early exit), or a call ready to run and whether it may share. */
export type Prepared<P, R> = { done: R } | { ready: P; share: boolean };

export interface ScheduleSteps<T, P, R> {
  /** Before preparing: may this call share at all (its tool, its arguments as the model sent them)? false: a barrier */
  candidate(item: T, index: number): boolean;
  /** Parse, early exits, PreToolUse: in call order, one at a time */
  prepare(item: T, index: number): Promise<Prepared<P, R>>;
  /** Run a prepared call (approval, the tool, PostToolUse); `group` numbers the groups of the reply from 1 */
  run(ready: P, item: T, index: number, group: number): Promise<R>;
  /** A prepared call that will not run (a stop came first): its result */
  skip(ready: P, item: T, index: number): R;
  /** A run that threw (run should not): its result */
  failed(item: T, index: number, err: unknown): R;
  /** Store a result: in call order, as soon as every earlier call's is stored */
  commit(item: T, index: number, result: R): void;
  /** True once no further call may start (a stop, a hook's stop, the repeat guard) */
  stopped(): boolean;
  /** A group ended: its number, how many calls ran in it, its wall time */
  group?(group: number, size: number, wallMs: number): void;
  now?(): number;
}

/**
 * Runs the calls. Resolves once every call that started has ended and every result there is was committed; calls
 * after a stop are neither prepared nor run (the caller fills them in, as Agent.repairTail does).
 */
export async function runSchedule<T, P, R>(items: readonly T[], limit: number, steps: ScheduleSteps<T, P, R>): Promise<void> {
  const max = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || 1));
  const now = steps.now ?? (() => performance.now());
  const results = new Map<number, R>();
  let next = 0;
  const commitReady = () => {
    while (results.has(next)) {
      const r = results.get(next) as R;
      results.delete(next);
      steps.commit(items[next], next, r);
      next++;
    }
  };
  const settle = (i: number, r: R) => {
    results.set(i, r);
    commitReady();
  };
  const running = new Set<Promise<void>>();
  const drain = async () => {
    while (running.size) await Promise.all([...running]);
  };
  // The group being filled: its number, size and start; closed by a barrier or the end
  let group = 0;
  let open: { n: number; size: number; at: number } | null = null;
  const close = async () => {
    await drain();
    if (open) steps.group?.(open.n, open.size, now() - open.at);
    open = null;
  };
  const runOne = (ready: P, i: number, g: number): Promise<R> => steps.run(ready, items[i], i, g).catch((err: unknown) => steps.failed(items[i], i, err));

  for (let i = 0; i < items.length; i++) {
    if (steps.stopped()) break;
    const may = max > 1 && steps.candidate(items[i], i);
    if (!may) await close();
    else while (running.size >= max) await Promise.race([...running]);
    if (steps.stopped()) break;
    const p = await steps.prepare(items[i], i);
    if ('done' in p) {
      settle(i, p.done);
      continue;
    }
    if (!may || !p.share) {
      // A barrier: everything before it ends first
      await close();
      if (steps.stopped()) {
        settle(i, steps.skip(p.ready, items[i], i));
        break;
      }
      const g = ++group;
      const at = now();
      settle(i, await runOne(p.ready, i, g));
      steps.group?.(g, 1, now() - at);
      continue;
    }
    if (steps.stopped()) {
      settle(i, steps.skip(p.ready, items[i], i));
      break;
    }
    if (!open) open = { n: ++group, size: 0, at: now() };
    open.size++;
    const g = open.n;
    const task: Promise<void> = runOne(p.ready, i, g).then((r) => {
      running.delete(task);
      settle(i, r);
    });
    running.add(task);
  }
  await close();
}
