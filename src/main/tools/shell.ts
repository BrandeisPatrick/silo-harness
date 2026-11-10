import { spawn } from 'node:child_process';
import os from 'node:os';
import type { Tool } from './types';
import { truncateMiddle } from './types';

const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${os.homedir()}/.local/bin`, `${os.homedir()}/.cargo/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Output kept per stream; the tool result is cut much shorter than this anyway */
const MAX_BUFFER = 20 * 1024 * 1024;
/** What the result keeps of stdout and stderr together: their start and their end (the exit code comes after) */
export const OUTPUT_BUDGET = 30_000;

/** stdout and stderr cut to OUTPUT_BUDGET together, each keeping its start and end, then the exit code, which is never cut. */
export function shellResult(stdout: string, stderr: string, code: string | number): string {
  const total = stdout.length + stderr.length;
  if (total > OUTPUT_BUDGET) {
    // stderr gets its share, at least 6,000 characters when it has them (a failing build's errors)
    const errBudget = Math.min(stderr.length, Math.max(6000, Math.floor((OUTPUT_BUDGET * stderr.length) / total)));
    stdout = truncateMiddle(stdout, OUTPUT_BUDGET - errBudget);
    stderr = truncateMiddle(stderr, errBudget);
  }
  let out = stdout;
  if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
  return out + `${out.endsWith('\n') || !out ? '' : '\n'}[exit code: ${code}]`;
}

function buildPath(): string {
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const merged = [...current];
  for (const p of EXTRA_PATH) if (!merged.includes(p)) merged.push(p);
  return merged.join(':');
}

export const bash: Tool = {
  name: 'bash',
  description:
    'Run a shell command (zsh) in the working directory and return stdout, stderr and the exit code. Non-interactive only: never run commands that wait for input. Default timeout 120 s, max 600 s.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      description: { type: 'string', description: 'What the command does, in 5–10 words, for the user (shown when it asks for approval), e.g. "List the files in src"' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('command is required');
    const approval = await ctx.approve('bash', command);
    if (!approval.ok) return { content: approval.message };
    const timeout = Math.min(Math.max(1000, Number(args.timeout_ms) || 120_000), 600_000);
    return new Promise((resolve) => {
      let stopped: 'user' | 'timeout' | null = null;
      let settled = false;
      let stdout = '';
      let stderr = '';
      // Its own process group, so that stopping the command also stops what it started (a sleep, a build, a server).
      // No stdin: a command that tries to read input sees end-of-file instead of waiting for ever.
      const child = spawn('/bin/zsh', ['-lc', command], {
        cwd: ctx.cwd,
        env: { ...process.env, PATH: buildPath(), TERM: 'dumb', CI: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finish = (code: string | number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({ content: shellResult(stdout, stderr, code) });
      };
      const outcome = (code: number | null, signal: NodeJS.Signals | null): string | number =>
        stopped === 'user' ? 'stopped by the user' : stopped === 'timeout' ? `killed (timeout after ${timeout} ms)` : signal ? `killed (${signal})` : (code ?? 0);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (stdout.length < MAX_BUFFER) stdout += d;
      });
      child.stderr.on('data', (d: string) => {
        if (stderr.length < MAX_BUFFER) stderr += d;
      });
      child.on('error', (err) => finish(err.message));
      // 'close' waits for the output pipes too, so nothing a child printed is lost.
      child.on('close', (code, signal) => finish(outcome(code, signal)));
      const signalGroup = (sig: NodeJS.Signals) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          child.kill(sig); // the group is already gone
        }
      };
      const stop = (why: 'user' | 'timeout') => {
        if (stopped || settled) return;
        stopped = why;
        signalGroup('SIGTERM');
        // A command that ignores SIGTERM does not get to hold the run open…
        setTimeout(() => signalGroup('SIGKILL'), 2000).unref();
        // …and neither does a process that left the group and still holds the output pipe.
        setTimeout(() => finish(outcome(null, null)), 3500).unref();
      };
      const timer = setTimeout(() => stop('timeout'), timeout);
      // Esc (or Stop from the remote) aborts the run: the command must end with it, not run on to its own finish.
      const onAbort = () => stop('user');
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};
