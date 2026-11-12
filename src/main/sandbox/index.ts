// The shell sandbox around the bash tool (docs/research/shell-sandbox-design.md): whether this Mac can run it (the
// probe), the folders a sandboxed command may write, the environment it gets, how a block shows in a command's exit
// and output, and the commands that skip the sandbox because they would surely hit its walls. The profile itself is
// in profile.ts; where the sandbox sits among the permission rules is in agent/permissions.ts.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allSimpleCommands, commandArgv, isReadOnlyCommand, sandboxGuardPaths } from '../guard';
import { SECRET_ENV_NAME } from '../env';
import { buildProfile, embeddable, SERVICE_PORTS, type Profile } from './profile';

export { buildProfile, embeddable, sandboxArgs, SERVICE_PORTS, type Profile, type ProfileInput } from './profile';

/** Spawned by absolute path, as /bin/zsh is: a copy planted on PATH cannot stand in */
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** AppConfig.sandbox: from the user's own settings.json only (a project's file may not set it). */
export interface SandboxSettings {
  /** Run Auto mode's commands (and Plan mode's reads) in the sandbox. Default false: opt in. */
  enabled: boolean;
  /** Let sandboxed commands use this Mac's own ports (localhost), but well-known services and Silo's own. Default false. */
  loopback: boolean;
  /** Folders sandboxed commands may also write (absolute or ~/…; not /, the home folder or a folder above it) */
  allowWrite: string[];
}

/** AppConfig.sandbox as it applies: each field its default (off, off, none) when absent or not the right type. */
export function sandboxSettings(raw: unknown): SandboxSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enabled: r.enabled === true,
    loopback: r.loopback === true,
    allowWrite: Array.isArray(r.allowWrite) ? r.allowWrite.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [],
  };
}

/** What the probe found: the temp folders a sandboxed command may write. */
export interface SandboxHost {
  temp: string[];
}

let probed: Promise<SandboxHost | null> | null = null;
/** The probe's answer once it has one (undefined until then) */
let probedNow: SandboxHost | null | undefined;

/** The probe's answer if it is in: the host, null (no sandbox here), or undefined (not probed yet). */
export function sandboxHostNow(): SandboxHost | null | undefined {
  return probedNow;
}

/** The real path of `p`, or of its nearest existing folder with the rest appended */
export function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
  return path.resolve(p);
}

const run = (file: string, args: string[], timeout = 5000): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });

/**
 * The temp folders: all of /private/tmp, the user's own /private/var/folders/<x>/<y> (where $TMPDIR and the cache
 * folder are; getconf names it whatever TMPDIR says), and $TMPDIR itself when it is elsewhere.
 */
async function tempFolders(): Promise<string[]> {
  const out = ['/private/tmp'];
  const conf = await run('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR']);
  const t = conf.code === 0 ? conf.stdout.trim() : '';
  // …/<x>/<y>/T/ → …/<x>/<y>, only when it has that shape
  if (t && /^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T\/?$/.test(t)) out.push(path.dirname(realish(t.replace(/\/+$/, ''))));
  const own = realish(os.tmpdir());
  if (!out.some((d) => own === d || own.startsWith(`${d}/`))) out.push(own);
  return out;
}

/**
 * Whether this Mac can run the sandbox: macOS, /usr/bin/sandbox-exec there and working (a process already in a
 * sandbox, or a Mac without the tool, fails here). Run once per app; null when it cannot, and the sandbox stays off
 * (commands go to the check as without it).
 */
export function probeSandbox(): Promise<SandboxHost | null> {
  if (!probed) {
    probed = (async () => {
      if (process.platform !== 'darwin') return null;
      const r = await run(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
      if (r.code !== 0) {
        console.warn(`[sandbox] ${SANDBOX_EXEC} does not work here (exit ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().split('\n')[0]}` : ''}): commands are checked as without it`);
        return null;
      }
      return { temp: await tempFolders() };
    })()
      .catch(() => null)
      .then((host) => (probedNow = host));
  }
  return probed;
}

/** For tests: forget the probe's answer, or set one. */
export function setProbeForTests(host: SandboxHost | null | undefined): void {
  probedNow = host;
  probed = host === undefined ? null : Promise.resolve(host);
}

const holds = (a: string, b: string): boolean => a === b || b.startsWith(a.endsWith('/') ? a : `${a}/`);
const SYSTEM_DIRS = new Set(['/System', '/Library', '/Applications', '/Users', '/Volumes', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/private/etc', '/private/var', '/opt', '/dev', '/cores', '/usr/local']);

/**
 * True for a folder the sandbox may treat as a project or a writable folder: not /, the home folder or a folder above
 * it, nor a system folder itself. A session in such a folder is not sandboxed: its commands are checked.
 */
export function sandboxableFolder(real: string, home: string = realish(os.homedir())): boolean {
  if (!path.isAbsolute(real)) return false;
  const p = real.replace(/\/+$/, '') || '/';
  return p !== '/' && !holds(p, home) && !SYSTEM_DIRS.has(p) && embeddable(p);
}

/** The folders of sandbox.allowWrite, ~ expanded and as real paths; an entry that is not absolute, or not sandboxable, is left out. */
export function extraFolders(list: readonly string[], home: string = os.homedir()): string[] {
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const e = raw.trim().replace(/^~(?=$|\/)/, home);
    if (!path.isAbsolute(e)) continue;
    const real = realish(e);
    if (sandboxableFolder(real, realish(home)) && !out.includes(real)) out.push(real);
  }
  return out;
}

/**
 * The local ports a sandboxed command never reaches with local ports open: the well-known services, and Silo's own
 * (the remote control's port, and the local model servers and gateways the config names).
 */
export function deniedPorts(cfg: unknown, own: (number | null | undefined)[] = []): number[] {
  const out = new Set<number>(SERVICE_PORTS);
  for (const p of own) if (typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536) out.add(p);
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 3) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'baseURL' || k === 'baseUrl') && typeof x === 'string') {
        try {
          const u = new URL(x);
          if (/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) out.add(Number(u.port) || (u.protocol === 'https:' ? 443 : 80));
        } catch {
          /* not a URL */
        }
      } else walk(x, depth + 1);
    }
  };
  walk(cfg, 0);
  return [...out].sort((a, b) => a - b);
}

/**
 * The profile for a session working in `cwd`, or null when that folder cannot be sandboxed (the home folder or above,
 * a system folder, a path the profile cannot hold): its commands then go to the check, as without the sandbox.
 */
export function profileFor(o: { cwd: string; settings: SandboxSettings; host: SandboxHost; readOnly: boolean; deniedPorts: number[] }): Profile | null {
  const home = realish(os.homedir());
  const project = realish(o.cwd);
  if (!sandboxableFolder(project, home)) return null;
  const g = sandboxGuardPaths(o.cwd);
  return buildProfile({
    project,
    temp: o.host.temp,
    extra: extraFolders(o.settings.allowWrite),
    loopback: o.settings.loopback,
    deniedPorts: o.deniedPorts,
    readOnly: o.readOnly,
    secretNames: g.secretNames,
    secretPaths: g.secretPaths,
    protectedPaths: g.protectedPaths,
    protectedFolders: g.protectedFolders,
  });
}

/** The environment a sandboxed command gets: without the variables whose names say they hold a secret (…KEY, …TOKEN, …SECRET, …PASSWORD). */
export function sandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV_NAME.test(k)) out[k] = v;
  return out;
}

// ---------- Blocks ----------

/**
 * What a block was, by the words that showed it: a refused operation (a write, a secret's content, a connection, a
 * signal: EPERM looks the same for each) or a refused name lookup. Only this reaches the safety check, never the
 * command's output, which the command chooses.
 */
export type BlockKind = 'refused' | 'lookup';

/** Output that shows a refused write, read, connection or name lookup (Codex and DeepSeek look for the same words) */
const BLOCK_SIGNS: { re: RegExp; kind: BlockKind }[] = [
  { re: /operation not permitted/i, kind: 'refused' },
  { re: /\bEPERM\b/, kind: 'refused' },
  { re: /\[Errno 1\]/, kind: 'refused' },
  { re: /nodename nor servname/i, kind: 'lookup' },
  { re: /\bENOTFOUND\b/, kind: 'lookup' },
  { re: /\bEAI_NONAME\b/, kind: 'lookup' },
  { re: /could not resolve host/i, kind: 'lookup' },
];

/** The fixed words the safety check reads for each kind of block */
export const BLOCK_KIND_WORDS: Record<BlockKind, string> = {
  refused: 'the sandbox refused an operation: a write outside the working directory and temp folders or to a protected file, reading a secret, a connection, or a signal to another process',
  lookup: 'the sandbox refused a name lookup: the command needs the network',
};

/** What showed a block: its kind, and the line (for the person, never the check), cut to a readable length. */
export interface SandboxBlock {
  kind: BlockKind;
  line: string;
}

/**
 * The block a sandboxed run hit, or null: a non-zero exit (not 126 or 127, where nothing ran, nor a stop or a timeout)
 * whose output holds the words of a refused operation, on a line the login profile does not print on its own
 * (`baseline`). A false alarm (a real permission error) costs a check and a rerun, today's price; a swallowed error is
 * missed, and the model can ask for outside: true.
 */
export function detectBlock(code: string | number, stdout: string, stderr: string, baseline: readonly string[] = []): SandboxBlock | null {
  if (typeof code !== 'number' || code === 0 || code === 126 || code === 127) return null;
  const known = new Set(baseline.map((l) => l.trim()));
  for (const text of [stderr, stdout]) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || known.has(line)) continue;
      const sign = BLOCK_SIGNS.find((s) => s.re.test(line));
      if (sign) return { kind: sign.kind, line: line.length > 300 ? `${line.slice(0, 299)}…` : line };
    }
  }
  return null;
}

/** True when sandbox-exec refused the profile itself (exit 65 and its own message): nothing ran. */
export function brokenProfile(code: string | number, stderr: string): boolean {
  return code === 65 && stderr.trimStart().startsWith('sandbox-exec:');
}

/** The lines a command printed, trimmed, for the per-session baseline of what the login profile prints. */
export function outputLines(stdout: string, stderr: string): string[] {
  return [...new Set(`${stderr}\n${stdout}`.split('\n').map((l) => l.trim()).filter(Boolean))];
}

// ---------- Commands that skip the sandbox ----------

/** Programs that reach the network, other apps, the keychain or launchd, or stop other processes: straight to the check */
const OUTSIDE_PROGRAMS = new Set([
  // other apps, launchd, preferences, the keychain, the clipboard, other processes
  'osascript', 'open', 'launchctl', 'kill', 'killall', 'pkill', 'defaults', 'security', 'pbcopy', 'pbpaste', 'shortcuts', 'automator', 'sudo', 'doas', 'tmux', 'screen', 'code', 'cursor',
  // the network
  'gh', 'ssh', 'scp', 'sftp', 'telnet', 'nc', 'ncat', 'ftp', 'ping', 'dig', 'nslookup', 'host', 'http', 'https', 'xh',
  'aws', 'gcloud', 'gsutil', 'az', 'kubectl', 'helm', 'terraform', 'pulumi', 'docker', 'podman', 'heroku', 'vercel', 'netlify', 'flyctl', 'fly',
  // package managers and installers that fetch, and caches in the home folder
  'brew', 'pipx', 'uv', 'uvx', 'poetry', 'pipenv', 'conda', 'mamba', 'xcodebuild', 'ollama',
  // local services on well-known ports
  'psql', 'mysql', 'redis-cli', 'mongosh', 'mongo',
]);
/** Subcommands of the JavaScript package managers that fetch from the registry */
const JS_FETCH = new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'remove', 'rm', 'uninstall', 'un', 'dedupe', 'audit', 'outdated', 'view', 'info', 'show', 'search', 'publish', 'login', 'dlx', 'create']);
/** Git commands that write nothing in .git (they run in the sandbox), and those that only list unless given more */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'cat-file', 'grep', 'rev-list', 'count-objects', 'help', 'version', 'var', 'check-ignore', 'check-attr', 'merge-base', 'name-rev', 'for-each-ref', 'show-ref', 'whatchanged', 'reflog', 'diff-tree', 'diff-files', 'diff-index']);
const GIT_LISTS = new Set(['branch', 'tag', 'remote', 'config', 'stash', 'worktree']);
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/**
 * The program that sends a command straight to the check instead of a sandboxed first run, or null: installs,
 * network clients (curl and wget to a host other than localhost, or to localhost with local ports closed), git
 * commands that write or reach a remote, cloud CLIs, and what acts on other apps or processes (osascript, open, kill,
 * launchctl). A wrong entry only costs today's check; a missing one a blocked first run.
 */
export function skipsSandbox(command: string, opts: { loopback?: boolean } = {}): string | null {
  let simples: string[];
  try {
    simples = allSimpleCommands(command.trim());
  } catch {
    return null;
  }
  for (const simple of simples) {
    const argv = commandArgv(simple);
    const prog = path.basename(argv[0] ?? '');
    if (!prog) continue;
    const words = argv.slice(1).filter((a) => !a.startsWith('-'));
    if (OUTSIDE_PROGRAMS.has(prog)) return prog;
    if (prog === 'curl' || prog === 'wget') {
      const urls = words.filter((w) => /^[a-z]+:\/\//i.test(w) || /^[\w.-]+(:\d+)?(\/|$)/.test(w));
      if (!opts.loopback || !urls.length || urls.some((u) => !LOCAL_URL.test(u))) return prog;
      continue;
    }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) {
      if ((prog === 'yarn' && !words.length) || JS_FETCH.has(words[0] ?? '')) return `${prog} ${words[0] ?? ''}`.trim();
      continue;
    }
    if (/^pip3?(\.\d+)?$/.test(prog) || (/^python3?(\.\d+)?$/.test(prog) && argv.includes('-m') && argv[argv.indexOf('-m') + 1] === 'pip')) {
      if (words.some((w) => ['install', 'download', 'uninstall', 'wheel', 'index', 'search'].includes(w))) return 'pip';
      continue;
    }
    if (prog === 'gem' && ['install', 'update', 'push', 'fetch'].includes(words[0] ?? '')) return 'gem';
    if (prog === 'bundle' && ['install', 'update', 'add', 'outdated'].includes(words[0] ?? '')) return 'bundle';
    if (prog === 'cargo' && ['install', 'add', 'update', 'fetch', 'publish', 'search', 'login'].includes(words[0] ?? '')) return 'cargo';
    if (prog === 'go' && (['get', 'install'].includes(words[0] ?? '') || (words[0] === 'mod' && ['download', 'tidy'].includes(words[1] ?? '')))) return 'go';
    if (prog === 'deno' && ['install', 'add', 'cache', 'upgrade'].includes(words[0] ?? '')) return 'deno';
    if (prog === 'swift' && words[0] === 'package' && ['resolve', 'update'].includes(words[1] ?? '')) return 'swift package';
    if (prog === 'composer' || prog === 'mvn' || prog === 'gradle' || prog === 'gradlew') return prog;
    if (prog === 'rsync' && words.some((t) => /^[\w.-]+@[\w.-]+:|^[\w.-]+:[^/]/.test(t))) return 'rsync';
    if (prog === 'git') {
      // (git's global options before the subcommand: -C <dir>, -c <k=v> … take a value)
      let i = 1;
      while (i < argv.length && argv[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(argv[i]) ? 2 : 1;
      const sub = argv[i] ?? '';
      if (GIT_READS.has(sub) && !argv.slice(1, i).some((a) => /^(-c|--config-env|--exec-path|--git-dir|--work-tree)(=|$)/.test(a))) continue;
      if (GIT_LISTS.has(sub) && isReadOnlyCommand(simple)) continue;
      return `git ${sub}`.trim();
    }
  }
  return null;
}
