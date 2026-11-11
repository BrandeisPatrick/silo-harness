// Auto mode's fixed rules and words: what always asks even in Auto mode (sudo, deleting a critical folder), which
// paths are protected (an allow rule does not skip the safety check for them), what the agent reads when the check
// blocks an action, and how a blocked action is named on one line. Pure; the check itself is in classifier.ts.

import os from 'node:os';
import path from 'node:path';
import { commandArgv, lineCommands, lineFolders } from '../guard';

/** Blocks in a row, and in all, after which Auto mode pauses for the session (the approval cards come back). */
export const PAUSE_IN_A_ROW = 3;
export const PAUSE_TOTAL = 20;

/** How a blocked call's result starts (what the agent reads, and how a stored transcript finds the call again). */
export const BLOCKED_PREFIX = 'Blocked by Auto mode: ';
/** The reason when the check could not run (an error, a timeout, an answer that was not one): fail closed. */
export const UNAVAILABLE_REASON = '[Unavailable] the safety check could not run';
/** A user-role note to the agent about Auto mode (an allowed block): sent to the model, not shown as a turn. */
export const AUTO_NOTE_PREFIX = '[Auto mode] ';

/** What the agent reads in place of the blocked call's result. */
export function blockedResult(reason: string): string {
  const r = reason.trim().replace(/[.\s]+$/, '');
  return `${BLOCKED_PREFIX}${r}. Do not try to get around it; continue with other work, or ask the user.`;
}

/** The check's reason in a blocked call's result, or null when the result is not a block. */
export function blockedReason(result: string): string | null {
  if (!result.startsWith(BLOCKED_PREFIX)) return null;
  const rest = result.slice(BLOCKED_PREFIX.length);
  const end = rest.indexOf('. Do not try to get around it');
  return (end >= 0 ? rest.slice(0, end) : rest.split('\n')[0]).trim();
}

/** The note the agent gets when the user allows a blocked action. */
export function allowedNote(what: string): string {
  return `${AUTO_NOTE_PREFIX}The user allowed an action Auto mode blocked: ${what}. You may try it again now; it runs once without the check.`;
}

const home = (): string => os.homedir();

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, home()).replace(/^\$\{?HOME\}?(?=$|\/)/, home());
}

/** The tilde form of a path under the home folder. */
function tilde(p: string): string {
  const h = home();
  return p === h ? '~' : p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
}

/** a is b or a folder that holds b */
function holds(a: string, b: string): boolean {
  return a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

const SYSTEM_DIRS = ['/System', '/Library', '/Applications', '/Users', '/Volumes', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/dev', '/cores', '/private/etc', '/private/var', '/usr/local'];

/**
 * True when deleting `target` (as an rm or rmdir argument, from `base`: the working directory or a folder a cd in the
 * line moved to) takes a critical folder or everything in one: the root, the home folder, the working directory `cwd`
 * itself or a folder above it or the home folder, or a system folder.
 */
export function criticalTarget(target: string, cwd: string, base = cwd): boolean {
  let t = expandHome(target.trim());
  if (!t) return false;
  // "dir/*" deletes everything in dir; "*" everything in the working directory
  t = t.replace(/\/\*+$/, '') || '/';
  if (t === '*' || t === '.*') t = '.';
  if (t.length > 1) t = t.replace(/\/+$/, '');
  const abs = path.resolve(base, t);
  if (abs === '/') return true;
  const root = path.resolve(cwd);
  if (holds(abs, root) || holds(abs, home())) return true;
  return SYSTEM_DIRS.includes(abs);
}

/**
 * Why a command asks the user even in Auto mode, whatever the safety check would say: it deletes a critical folder
 * (rm or rmdir of the home folder, /, the working directory itself, a system folder, from any folder a cd in the line
 * may have moved to), or it uses sudo; the first wins (sudo rm -rf ~ deletes a critical folder). Null otherwise.
 * Commands inside substitutions, sh -c and eval strings, what xargs or find -exec runs, and what sudo runs, count too.
 */
export function alwaysAskReason(command: string, cwd: string): string | null {
  const folders = lineFolders(command, cwd);
  let sudo = false;
  for (const simple of lineCommands(command)) {
    const argv = commandArgv(simple);
    const prog = path.basename(argv[0] ?? '');
    if (prog === 'sudo' || prog === 'doas') sudo = true;
    if (prog === 'rm' || prog === 'rmdir') {
      const args = argv.slice(1);
      const dash = args.indexOf('--');
      const targets = dash >= 0 ? [...args.slice(0, dash).filter((a) => !a.startsWith('-')), ...args.slice(dash + 1)] : args.filter((a) => !a.startsWith('-'));
      if (targets.some((t) => folders.dirs.some((d) => criticalTarget(t, cwd, d)))) return 'deletes a critical folder';
    }
  }
  return sudo ? 'uses sudo' : null;
}

/**
 * Why a write to `abs` is protected (it asks in every mode but Bypass, and no allow rule covers it), or null. The
 * rules are in guard.ts, where the shell guard uses them too.
 */
export { protectedWrite, PROTECTED_REASONS } from '../guard';

/** The key a once-allowed action is found by when the agent tries it again: the tool and what its approval showed. */
export function actionKey(name: string, detail: string): string {
  return `${name}\u0000${detail}`;
}

const oneLine = (s: string, max = 200): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * A blocked action on one line, for the quiet line, Settings and the agent's note: the command, the file (with ~),
 * "tool on server" for an MCP call. `args` are the call's arguments (an object or its JSON); `detail` what its
 * approval showed, used when the arguments do not say.
 */
export function actionLine(name: string, args: unknown, detail = ''): string {
  let a: Record<string, unknown> = {};
  if (typeof args === 'string') {
    try {
      const v = JSON.parse(args) as unknown;
      if (v && typeof v === 'object') a = v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  } else if (args && typeof args === 'object') a = args as Record<string, unknown>;
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  // (bash's path, as its row shows it: cd <path> && <command>)
  if (name === 'bash' || name === 'terminal_run') return oneLine((name === 'bash' && s('path').trim() && s('command') ? `cd ${s('path').trim()} && ` : '') + (s('command') || detail));
  if (name === 'write_file' || name === 'edit_file') {
    const p = s('path') || detail.split('\n')[0];
    return oneLine(`${name === 'write_file' ? 'write' : 'edit'} ${tilde(expandHome(p))}`);
  }
  // A browser action: the card's first line, lower-cased for "Auto mode blocked open example.com" (a stored
  // transcript has no card: the URL, or the tool)
  if (name.startsWith('browser_') || name === 'web_fetch') {
    const first = detail.split('\n')[0] || (s('url') ? `open ${s('url')}` : name);
    return oneLine(first.charAt(0).toLowerCase() + first.slice(1));
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return oneLine(`${mcp[2]} on ${mcp[1]}`);
  return oneLine(detail.split('\n')[0] || name);
}
