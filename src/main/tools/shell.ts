import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandArgv, commandIn, shellStart, splitCommands } from '../guard';
import type { Tool } from './types';
import { truncateMiddle } from './types';

const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${os.homedir()}/.local/bin`, `${os.homedir()}/.cargo/bin`, '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Output kept per stream; the tool result is cut much shorter than this anyway */
const MAX_BUFFER = 20 * 1024 * 1024;
/** What the result keeps of stdout and stderr together: their start and their end (the exit code comes after) */
export const OUTPUT_BUDGET = 30_000;

/**
 * The known sign-ins that wait for the user (a browser, a code, a password prompt), which cannot finish in this
 * tool: its name as the user would type it, or null. Every simple command of the line is looked at.
 */
export function interactiveLogin(command: string): string | null {
  for (const simple of splitCommands(command)) {
    const argv = commandArgv(simple);
    const prog = path.basename(argv[0] ?? '');
    const words = argv.slice(1).filter((a) => !a.startsWith('-'));
    const has = (...o: string[]) => argv.some((a) => o.some((x) => a === x || a.startsWith(x + '=')));
    const seq = (...s: string[]) => words.slice(0, s.length).join(' ') === s.join(' ');
    const anywhere = (...s: string[]) => argv.some((_, i) => argv.slice(i, i + s.length).join(' ') === s.join(' '));
    if (prog === 'aws' && (anywhere('sso', 'login') || anywhere('configure', 'sso') || seq('login'))) return anywhere('configure', 'sso') ? 'aws configure sso' : anywhere('sso', 'login') ? 'aws sso login' : 'aws login';
    if (prog === 'gcloud' && (seq('auth', 'login') || seq('auth', 'application-default', 'login')) && !has('--cred-file')) return `gcloud ${words.slice(0, words[1] === 'login' ? 2 : 3).join(' ')}`;
    if (prog === 'az' && seq('login') && !has('--service-principal', '--identity', '--federated-token')) return 'az login';
    if (prog === 'gh' && seq('auth', 'login') && !has('--with-token')) return 'gh auth login';
    if (prog === 'npm' && (seq('login') || seq('adduser') || seq('add-user'))) return `npm ${words[0]}`;
    if (prog === 'docker' && seq('login') && !has('--password-stdin', '--password', '-p')) return 'docker login';
  }
  return null;
}

/** What the shell's result says when a command is a sign-in that waits for the user */
export function loginRedirect(login: string): string {
  return `Not run: ${login} waits for the user to sign in, which this tool cannot show. Run it with terminal_run, in a terminal the user can type in.`;
}

/** The hint after a result, before its exit code: a timeout, or a missing timeout command on macOS */
function hintFor(code: string | number, stderr: string, timeout: number): string | null {
  if (typeof code === 'string' && code.startsWith('killed (timeout')) return `[timed out: raise timeout_ms (up to 600000, now ${timeout}), or run it with terminal_run]`;
  if (/command not found: g?timeout\b/.test(stderr)) return "[macOS has no timeout: use this tool's timeout_ms]";
  return null;
}

/** stdout and stderr cut to OUTPUT_BUDGET together, each keeping its start and end, then a hint, then the exit code, which is never cut. */
export function shellResult(stdout: string, stderr: string, code: string | number, hint: string | null = null): string {
  const total = stdout.length + stderr.length;
  if (total > OUTPUT_BUDGET) {
    // stderr gets its share, at least 6,000 characters when it has them (a failing build's errors)
    const errBudget = Math.min(stderr.length, Math.max(6000, Math.floor((OUTPUT_BUDGET * stderr.length) / total)));
    stdout = truncateMiddle(stdout, OUTPUT_BUDGET - errBudget);
    stderr = truncateMiddle(stderr, errBudget);
  }
  let out = stdout;
  if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
  if (hint) out += `${out.endsWith('\n') || !out ? '' : '\n'}${hint}`;
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
    'Run a shell command (zsh) and return stdout, stderr and the exit code. Calls start in the working directory; path picks another folder. Edit files with edit_file or write_file, not scripts. Non-interactive only: never run commands that wait for input; a sign-in (aws sso login, gh auth login) needs terminal_run. Default timeout 120 s, max 600 s. To find a file anywhere on this Mac use mdfind -name <name>, not find ~.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute' },
      path: { type: 'string', description: 'Folder to start in (default: working directory)' },
      description: { type: 'string', description: 'What the command does, in 5–10 words, for the user (shown when it asks for approval), e.g. "List the files in src"' },
      timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('command is required');
    // A sign-in that waits for the user cannot finish here (no terminal, no stdin): said at once, before any approval
    const login = interactiveLogin(command);
    if (login) return { content: loginRedirect(login) };
    // Another folder (path) is approved, checked and shown as `cd '<folder>' && <command>` (guard.ts commandIn)
    const start = shellStart(args.path, ctx.cwd);
    const approval = await ctx.approve('bash', commandIn(command, start, ctx.cwd));
    if (!approval.ok) return { content: approval.message };
    if (start !== path.resolve(ctx.cwd) && !(await fs.stat(start).then((st) => st.isDirectory(), () => false))) throw new Error(`path is not a folder: ${start}`);
    const timeout = Math.min(Math.max(1000, Number(args.timeout_ms) || 120_000), 600_000);
    return new Promise((resolve) => {
      let stopped: 'user' | 'timeout' | null = null;
      let settled = false;
      let stdout = '';
      let stderr = '';
      // Its own process group, so that stopping the command also stops what it started (a sleep, a build, a server).
      // No stdin: a command that tries to read input sees end-of-file instead of waiting for ever.
      // An unmatched wildcard passes through as in bash (grep --include=*.ts), set after the login profile has run.
      // No cd search path and no cd to a variable's value: `cd sub` goes to ./sub or fails, as the guard reads it
      // (leadingCd), whatever CDPATH or the login profile set
      const child = spawn('/bin/zsh', ['-lc', `setopt nonomatch; cdpath=(); unsetopt cdablevars; ${command}`], {
        cwd: start,
        env: { ...process.env, PATH: buildPath(), TERM: 'dumb', CI: '1' },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const finish = (code: string | number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        resolve({ content: shellResult(stdout, stderr, code, hintFor(code, stderr, timeout)) });
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
      child.on('error', (err) => finish(`could not start (${err.message})`));
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
