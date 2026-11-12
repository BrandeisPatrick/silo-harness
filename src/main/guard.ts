// The auto-mode guard: pure rules that decide which commands and writes still need the user's OK.
// Also: the plan-mode read-only allowlist and the "program" of a command for session allow-lists.
// A heuristic over the command text, not a sandbox: it looks inside $(…), backticks, <(…), sh -c '…', eval, xargs
// and find -exec, at what sudo runs, and at redirections (at every folder a cd in the line may have moved to), but a
// command can still hide what it runs (a script file, a variable).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from './paths';

/** A simple command and the operator before it ('' for the first; ';', '\n', '&&', '||', '|', '&'). */
interface Part {
  cmd: string;
  op: string;
  /** Where its text starts in the line (just after the operator before it) */
  at: number;
}

/**
 * Split a command line into simple commands on newlines, ;, &, &&, |, || (quote-aware, no heredoc parsing). The text
 * of $(…), <(…), >(…) and backticks stays inside its simple command; & and | that belong to a redirection (2>&1, &>f,
 * >|f) do not split.
 */
function splitParts(command: string): Part[] {
  const parts: Part[] = [];
  let cur = '';
  let op = '';
  let quote: string | null = null;
  let depth = 0;
  let at = 0;
  let i = 0;
  const push = (next: string) => {
    parts.push({ cmd: cur, op, at });
    cur = '';
    op = next;
    at = i + 1;
  };
  for (; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' && (depth > 0 || (i > 0 && '$<>='.includes(command[i - 1])))) {
      depth++;
      cur += c;
      continue;
    }
    if (c === ')' && depth > 0) {
      depth--;
      cur += c;
      continue;
    }
    if (depth > 0) {
      cur += c;
      continue;
    }
    const prev = command[i - 1] ?? '';
    if (c === '\n' || c === ';') {
      push(c);
      continue;
    }
    if (c === '&') {
      // part of a redirection: >&2, <&0, &>file, &>>file
      if (prev === '>' || prev === '<' || command[i + 1] === '>') {
        cur += c;
        continue;
      }
      if (command[i + 1] === '&') {
        i++;
        push('&&');
        continue;
      }
      push('&');
      continue;
    }
    if (c === '|') {
      if (prev === '>') {
        cur += c; // >| clobber
        continue;
      }
      if (command[i + 1] === '|') {
        i++;
        push('||');
        continue;
      }
      if (command[i + 1] === '&') i++; // |& pipes stderr too
      push('|');
      continue;
    }
    cur += c;
  }
  parts.push({ cmd: cur, op, at });
  return parts.map((p) => ({ cmd: p.cmd.trim(), op: p.op, at: p.at })).filter((p) => p.cmd);
}

/** Split a command line into simple commands on newlines, ;, &, &&, |, || (quote-aware, no heredoc parsing). */
export function splitCommands(command: string): string[] {
  return splitParts(command).map((p) => p.cmd);
}

/** Words of a simple command with quotes removed (rough: no variable expansion). */
export function words(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Index of the ) that closes the ( at `open`, quote-aware; the end of the text when there is none. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

/**
 * The command texts inside substitutions: $(…), backticks, <(…), >(…) and zsh's =(…). `found` is also true for
 * ${…@P}, ${!…} and zsh's ${(e)…}-style flags, which expand to code or to other variables. $((…)) arithmetic and
 * plain $VAR / ${VAR} are not substitutions here. Text in single quotes is literal.
 */
export function substitutions(s: string): { inner: string[]; found: boolean } {
  const inner: string[] = [];
  let found = false;
  let dq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" && !dq) {
      const end = s.indexOf("'", i + 1);
      i = end < 0 ? s.length : end;
      continue;
    }
    if (c === '"') {
      dq = !dq;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1;
      inner.push(s.slice(i + 1, j));
      found = true;
      i = j;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      if (s[i + 2] === '(') {
        i += 2; // $(( arithmetic: its text is scanned on
        continue;
      }
      const j = closingParen(s, i + 1);
      inner.push(s.slice(i + 2, j));
      found = true;
      i = j;
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i + 2);
      const body = s.slice(i + 2, end < 0 ? s.length : end);
      if (body.startsWith('!') || body.startsWith('(') || /@P/.test(body)) found = true;
      continue;
    }
    if (!dq && (c === '<' || c === '>' || (c === '=' && (i === 0 || /\s/.test(s[i - 1])))) && s[i + 1] === '(') {
      const j = closingParen(s, i + 1);
      inner.push(s.slice(i + 2, j));
      found = true;
      i = j;
    }
  }
  return { inner, found };
}

/** A simple command lexed: its words (quotes removed, redirections left out) and what it redirects into and from. */
interface Lexed {
  words: string[];
  /** Files written by > >> >| &> &>> >&file <> */
  writes: string[];
  /** Files read by < and <> */
  reads: string[];
}

const BREAKS = new Set([' ', '\t', '\n', '<', '>', '|', ';', '&']);

function lex(cmd: string): Lexed {
  const out: Lexed = { words: [], writes: [], reads: [] };
  let i = 0;
  const n = cmd.length;
  // One shell word from i: quotes removed, $(…) <(…) >(…) kept whole.
  const word = (): string => {
    let cur = '';
    while (i < n) {
      const c = cmd[i];
      if (c === "'" || c === '"') {
        const end = cmd.indexOf(c, i + 1);
        const stop = end < 0 ? n : end;
        cur += cmd.slice(i + 1, stop);
        i = stop + 1;
        continue;
      }
      if (c === '\\' && i + 1 < n) {
        cur += cmd[i + 1];
        i += 2;
        continue;
      }
      if ((c === '$' || c === '<' || c === '>' || c === '=') && cmd[i + 1] === '(') {
        const j = closingParen(cmd, i + 1);
        cur += cmd.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '`') {
        let j = i + 1;
        while (j < n && cmd[j] !== '`') j += cmd[j] === '\\' ? 2 : 1;
        cur += cmd.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (BREAKS.has(c)) break;
      cur += c;
      i++;
    }
    return cur;
  };
  const skipSpace = () => {
    while (i < n && /\s/.test(cmd[i])) i++;
  };
  while (i < n) {
    skipSpace();
    if (i >= n) break;
    const m = /^(\d+|&)?(>>|>\||>&|<>|<&|<<<|<<-?|>|<)/.exec(cmd.slice(i));
    if (m && !(cmd[i + m[0].length] === '(' && (m[2] === '>' || m[2] === '<'))) {
      const op = m[2];
      i += m[0].length;
      skipSpace();
      const target = word();
      if (op === '<<' || op === '<<-' || op === '<<<' || op === '<&') continue;
      if (op === '>&') {
        if (!/^(\d+-?|-)$/.test(target)) out.writes.push(target);
        continue;
      }
      if (op === '<') out.reads.push(target);
      else if (op === '<>') {
        out.reads.push(target);
        out.writes.push(target);
      } else out.writes.push(target);
      continue;
    }
    const start = i;
    const w = word();
    if (i === start) {
      i++; // a stray | ; & the splitter left
      continue;
    }
    out.words.push(w);
  }
  return out;
}

const WRAPPERS = new Set(['env', 'nohup', 'time', 'nice', 'exec', 'command', 'builtin', 'caffeinate']);
/** A wrapper's options that take a value */
const WRAPPER_VALUE_FLAGS: Record<string, string[]> = { env: ['-u', '-C', '-S', '-P'], nice: ['-n'], caffeinate: ['-t', '-w'], time: ['-o', '-f'] };
/** Words that start a command without being its program */
const LEADERS = new Set(['!', '{', '(', 'do', 'then', 'else', 'elif', 'if', 'while', 'until']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

/** A simple command's program and arguments: leading keywords, env assignments and wrappers (env, nohup, time …) skipped. */
function argvOf(simple: string): { argv: string[]; assigns: boolean; lexed: Lexed } {
  const lexed = lex(simple);
  const w = lexed.words.slice();
  if (w[0] && /^[({]./.test(w[0])) w[0] = w[0].replace(/^[({]+/, '');
  let i = 0;
  let assigns = false;
  while (i < w.length) {
    if (LEADERS.has(w[i])) {
      i++;
      continue;
    }
    if (ASSIGNMENT.test(w[i])) {
      assigns = true;
      i++;
      continue;
    }
    if (WRAPPERS.has(w[i])) {
      let j = i + 1;
      const valued = WRAPPER_VALUE_FLAGS[w[i]] ?? [];
      while (j < w.length && (w[j].startsWith('-') || (w[i] === 'env' && ASSIGNMENT.test(w[j])))) {
        if (ASSIGNMENT.test(w[j])) assigns = true;
        j += valued.includes(w[j]) ? 2 : 1;
      }
      if (j >= w.length) break; // `env` or `time` alone is the program
      i = j;
      continue;
    }
    break;
  }
  const argv = w.slice(i);
  // a subshell or group after a keyword: do (cd x; …)
  if (i > 0 && argv[0] && /^[({]./.test(argv[0])) argv[0] = argv[0].replace(/^[({]+/, '');
  // the ) that closes a subshell: (cd x; rm -rf ~)
  const last = argv.length - 1;
  if (last > 0 && argv[last].endsWith(')') && (argv[last].match(/\)/g) ?? []).length > (argv[last].match(/\(/g) ?? []).length) {
    argv[last] = argv[last].replace(/\)+$/, '');
    if (!argv[last]) argv.pop();
  }
  return { argv, assigns, lexed };
}

/** The program and arguments of a simple command (see argvOf), quotes removed and redirections left out. */
export function commandArgv(simple: string): string[] {
  return argvOf(simple).argv;
}

/**
 * A simple command as the permission rules match it (agent/rules.ts): its program and arguments (see argvOf), whether
 * it starts with a VAR=value assignment, and the files its redirections write.
 */
export function commandShape(simple: string): { argv: string[]; assigns: boolean; writes: string[] } {
  const { argv, assigns, lexed } = argvOf(simple);
  return { argv, assigns, writes: lexed.writes.filter((t) => !NULL_DEVICES.has(t)) };
}

/** The program a simple command runs: env assignments and wrappers like env/nohup/time are skipped; sudo counts as the program. */
export function programOf(simple: string): string {
  return path.basename(argvOf(simple).argv[0] ?? '');
}

/** Programs of every simple command in a command line, those inside substitutions and sh -c strings included, deduplicated, in order. */
export function programsOf(command: string): string[] {
  const seen: string[] = [];
  for (const simple of allSimpleCommands(command)) {
    const p = programOf(simple);
    if (p && !seen.includes(p)) seen.push(p);
  }
  return seen;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** xargs options that take a value as the next word */
const XARGS_VALUE_FLAGS = new Set(['-I', '-J', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '-R', '-S', '--max-args', '--max-procs', '--delimiter', '--arg-file', '--max-lines', '--replace']);

/** A word list back into a command line */
function joinWords(w: string[]): string {
  return w.map((x) => (/^[\w@%+=:,./~-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The commands a simple command runs from its arguments: sh -c and eval strings, xargs and find -exec programs, timeout's command. */
function nestedCommands(argv: string[], piped: string | null): string[] {
  const prog = path.basename(argv[0] ?? '');
  const args = argv.slice(1);
  if (SHELLS.has(prog)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c >= 0) {
      const script = args.slice(c + 1).find((a) => !a.startsWith('-'));
      return script !== undefined ? [script] : [];
    }
    return [];
  }
  if (prog === 'eval') return [args.join(' ')];
  if (prog === 'timeout' || prog === 'gtimeout') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += args[i] === '-s' || args[i] === '-k' || args[i] === '--signal' || args[i] === '--kill-after' ? 2 : 1;
    return args.length > i + 1 ? [joinWords(args.slice(i + 1))] : [];
  }
  if (prog === 'xargs') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += XARGS_VALUE_FLAGS.has(args[i]) ? 2 : 1;
    const run = args.slice(i);
    if (!run.length) run.push('echo');
    // `echo ~ | xargs rm -rf`: the words echo or printf feeds it are its arguments
    if (piped) {
      const p = argvOf(piped).argv;
      if (p[0] === 'echo' || p[0] === 'printf') run.push(...p.slice(1).filter((a) => !a.startsWith('-')));
    }
    return [joinWords(run)];
  }
  if (prog === 'find') {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i])) continue;
      const run: string[] = [];
      let j = i + 1;
      while (j < args.length && args[j] !== ';' && args[j] !== '+') run.push(args[j++]);
      if (run.length) out.push(joinWords(run));
      i = j;
    }
    return out;
  }
  return [];
}

const MAX_DEPTH = 4;
const MAX_COMMANDS = 200;

/**
 * Every simple command a command line runs as far as its text shows: the top-level ones, then (to a bounded depth)
 * those inside substitutions, sh/bash/zsh -c and eval strings, and the program xargs or find -exec runs.
 */
export function allSimpleCommands(command: string): string[] {
  const out: string[] = [];
  const walk = (text: string, depth: number) => {
    const parts = splitParts(text);
    parts.forEach((p, k) => {
      if (out.length >= MAX_COMMANDS) return;
      out.push(p.cmd);
      if (depth >= MAX_DEPTH) return;
      const nested = [...substitutions(p.cmd).inner, ...nestedCommands(argvOf(p.cmd).argv, k > 0 && p.op === '|' ? parts[k - 1].cmd : null)];
      for (const n of nested) walk(n, depth + 1);
    });
  };
  walk(command.trim(), 0);
  return out;
}

/** sudo's options that take a value (the rest of the cluster or the next word); doas has -u and -C */
const SUDO_VALUE_SHORT = 'ugpCDrtTUhR';
const SUDO_VALUE_LONG = new Set(['--user', '--group', '--prompt', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user', '--host', '--chroot']);

/** The command sudo or doas runs, its options and VAR=value words skipped; null when it is not one or runs none (sudo -s, sudo -e). */
export function sudoInner(argv: string[]): string | null {
  const prog = path.basename(argv[0] ?? '');
  if (prog !== 'sudo' && prog !== 'doas') return null;
  const valued = prog === 'sudo' ? SUDO_VALUE_SHORT : 'uC';
  let i = 1;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      i++;
      break;
    }
    if (a.startsWith('--')) {
      if (a === '--edit') return null;
      i += SUDO_VALUE_LONG.has(a) ? 2 : 1;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      let next = i + 1;
      for (let j = 1; j < a.length; j++) {
        if (prog === 'sudo' && a[j] === 'e') return null; // sudoedit: edits a file, runs no command
        if (valued.includes(a[j])) {
          if (j + 1 === a.length) next = i + 2;
          break;
        }
      }
      i = next;
      continue;
    }
    if (ASSIGNMENT.test(a)) {
      i++;
      continue;
    }
    break;
  }
  const rest = argv.slice(i);
  return rest.length ? joinWords(rest) : null;
}

/** allSimpleCommands, and after each sudo or doas command the commands it runs (what deny rules and the guard look through). */
export function lineCommands(command: string): string[] {
  const out: string[] = [];
  const walk = (text: string, depth: number) => {
    for (const s of allSimpleCommands(text)) {
      if (out.length >= MAX_COMMANDS) return;
      out.push(s);
      const inner = depth < MAX_DEPTH ? sudoInner(argvOf(s).argv) : null;
      if (inner) walk(inner, depth + 1);
    }
  };
  walk(command.trim(), 0);
  return out;
}

function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir()).replace(/^\$\{?HOME\}?(?=$|\/)/, os.homedir());
}

/** True when `target` is the working directory or inside it (both resolved). */
export function insideCwd(target: string, cwd: string): boolean {
  const abs = path.resolve(cwd, expandHome(target));
  const root = path.resolve(cwd);
  return abs === root || abs.startsWith(root + path.sep);
}

const TMP_RE = /^(\/private)?\/tmp(\/|$)|^\/var\/folders\//;
/** Redirection targets that write nothing */
const NULL_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

function isAbsolutePathArg(a: string): boolean {
  return a.startsWith('/') || a.startsWith('~') || a.startsWith('$HOME') || a.startsWith('${HOME}');
}

function pathArgsOutsideCwd(args: string[], cwd: string): string[] {
  return args.filter((a) => isAbsolutePathArg(a) && !insideCwd(a, cwd) && !TMP_RE.test(expandHome(a)) && !NULL_DEVICES.has(a));
}

/**
 * The folders a command line may be in: the session's folder, and each literal `cd` / `pushd` / `chdir` target
 * resolved against every folder already in the set (a set, not one current folder: subshells, loops and sh -c are
 * flattened, so the guard cannot tell which cd is still in effect). `unknown`: a cd whose target is not literal.
 */
export interface LineFolders {
  dirs: string[];
  unknown: boolean;
}

const CD_PROGRAMS = new Set(['cd', 'pushd', 'chdir']);
const MAX_FOLDERS = 16;

export function lineFolders(command: string, cwd: string): LineFolders {
  const out: LineFolders = { dirs: [path.resolve(cwd)], unknown: false };
  const add = (d: string) => {
    if (out.dirs.includes(d)) return;
    if (out.dirs.length >= MAX_FOLDERS) out.unknown = true;
    else out.dirs.push(d);
  };
  for (const simple of lineCommands(command)) {
    const argv = argvOf(simple).argv;
    const prog = path.basename(argv[0] ?? '');
    if (!CD_PROGRAMS.has(prog)) continue;
    const args = argv.slice(1);
    const dash = args.indexOf('--');
    const ops = dash >= 0 ? args.slice(dash + 1) : args.filter((a) => !/^-[A-Za-z@]+$/.test(a));
    // cd - and popd go back to a folder already in the set; cd -2 / pushd +1 turn the folder stack
    if (ops[0] === '-' || (ops.length === 1 && /^[+-]\d+$/.test(ops[0]))) continue;
    if (!ops.length) {
      if (prog !== 'pushd') add(os.homedir());
      continue;
    }
    const e = expandHome(ops[0]);
    if (ops.length > 1 || /[$`*?[{]/.test(e) || e.startsWith('~')) {
      out.unknown = true;
      continue;
    }
    for (const d of [...out.dirs]) add(path.resolve(d, e));
  }
  return out;
}

/** A path's brace alternatives (a{b,c} → ab, ac), or null past a bounded number */
function braceVariants(p: string, limit = 32): string[] | null {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(p);
  if (!m) return [p];
  const out: string[] = [];
  for (const alt of m[1].split(',')) {
    const more = braceVariants(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length), limit);
    if (!more || out.length + more.length > limit) return null;
    out.push(...more);
  }
  return out;
}

/**
 * Where a path a command names may be: absolute, or resolved against each folder the line may be in. Null when the
 * guard cannot place it: an expansion it cannot resolve ($X/…, ${D}, $(…), ~user; ~ and $HOME are resolved), or a
 * relative path after a cd it could not follow.
 */
function placements(p: string, folders: LineFolders): string[] | null {
  const out: string[] = [];
  const variants = braceVariants(p);
  if (!variants) return null;
  for (const v of variants) {
    const e = expandHome(v);
    if (/[$`]/.test(e) || e.startsWith('~')) return null;
    if (path.isAbsolute(e)) out.push(path.resolve(e));
    else if (folders.unknown) return null;
    else for (const d of folders.dirs) out.push(path.resolve(d, e));
  }
  return [...new Set(out)];
}

/** True when a path written by the line may be outside the session's folder (not /tmp, not a null device), or cannot be placed. */
function writesOutside(paths: string[], folders: LineFolders, cwd: string): boolean {
  return paths.some((p) => {
    if (!p || NULL_DEVICES.has(p)) return false;
    const at = placements(p, folders);
    return at === null || at.some((a) => !insideCwd(a, cwd) && !TMP_RE.test(a) && !NULL_DEVICES.has(a));
  });
}

/**
 * True when a path the line names is a secret at any folder the line may be in. At a folder a cd moved to, the path is
 * also judged where it lands (cd ~/.docker && cat config.json reads ~/.docker/config.json); at the session's own
 * folder (dirs[0]) by its text, as before.
 */
function secretAt(p: string, folders: LineFolders): boolean {
  return folders.dirs.some((d, i) => isSecretPath(p, d) || (i > 0 && SECRET_PATH_RE.test(path.resolve(d, expandHome(p)))));
}

/** A word `cd` may take as one plain literal folder: bare (no expansion, glob or escape), or one quoted word */
const CD_LINE = /^(?:cd|pushd)[ \t]+(?:([A-Za-z0-9_@%+=:,./~-]+)|'([^']*)'|"([^"$`\\!]*)")[ \t]*$/;

/**
 * The folder of a simple command that is exactly `cd <dir>` or `pushd <dir>` with one plain literal path, or null:
 * not for a variable, glob, brace, substitution, escape, ~user (~+, ~-, ~1 …), a leading - or +, =word, an option,
 * a second argument, a redirection, or a quoted ~ (literal to the shell, the home folder to the guard). `~` and `~/…`
 * are the home folder, as the shell and the guard both read them.
 */
function plainCdTarget(simple: string): string | null {
  const m = CD_LINE.exec(simple);
  if (!m) return null;
  const quoted = m[1] === undefined;
  const dir = m[1] ?? m[2] ?? m[3] ?? '';
  if (!dir || /^[-+=]/.test(dir) || /[\x00-\x1f\x7f]/.test(dir)) return null;
  if (quoted ? dir.startsWith('~') : /^~[^/]|.~/.test(dir)) return null;
  const e = quoted ? dir : expandHome(dir);
  if (/[$`*?[\]{}\\]/.test(e) || e.startsWith('~')) return null;
  return e;
}

/**
 * A line that starts with `cd <dir> &&` (or pushd; several in a row chain), each <dir> one plain literal path
 * (plainCdTarget): those folders in order and the rest of the line, as its text. Null for any other join after a cd
 * (; || | & a new line), and when the rest joins its commands with anything but && and | (after ; || & or a new line a
 * command may run in the folder the line started in, when a cd failed). The shell runs the rest in the last folder.
 */
export function leadingCd(command: string): { dirs: string[]; rest: string } | null {
  const raw = command.trim();
  const parts = splitParts(raw);
  const dirs: string[] = [];
  let k = 0;
  while (k < parts.length && (k === 0 || parts[k].op === '&&')) {
    const d = plainCdTarget(parts[k].cmd);
    if (d === null) break;
    dirs.push(d);
    k++;
  }
  if (!dirs.length || k >= parts.length || parts[k].op !== '&&') return null;
  if (parts.slice(k + 1).some((p) => p.op !== '&&' && p.op !== '|')) return null;
  const rest = raw.slice(parts[k].at).trim();
  return rest ? { dirs, rest } : null;
}

/** Where a shell call starts: `folder` (the bash tool's path) against the session's folder, ~ for home; the session's folder when none is given. */
export function shellStart(folder: unknown, cwd: string): string {
  if (typeof folder !== 'string' || !folder.trim()) return path.resolve(cwd);
  return path.resolve(cwd, folder.trim().replace(/^~(?=$|\/)/, os.homedir()));
}

/**
 * The command line the rules judge for a shell call that starts in `start` (shellStart): the command itself in the
 * session's folder, else `cd '<start>' && <command>`, which the guard, the read-only check, the permission rules,
 * hooks, the safety check and the approval card all read as the command run there (leadingCd).
 */
export function commandIn(command: string, start: string, cwd: string): string {
  if (path.resolve(start) === path.resolve(cwd)) return command;
  return `cd '${start.replace(/'/g, `'\\''`)}' && ${command.trim()}`;
}

/** The command line the rules judge for a bash or terminal_run call's arguments (bash's path folded in by commandIn), or null without a command. */
export function judgedCommand(name: string, args: unknown, cwd: string): string | null {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  if (typeof a.command !== 'string') return null;
  return name === 'bash' ? commandIn(a.command, shellStart(a.path, cwd), cwd) : a.command;
}

const BROAD_TARGETS = new Set(['/', '~', '$HOME', '*', './*', '..', '../', '.', './', '~/', '/*']);

/** Git's global options before the subcommand that take a value as the next word */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);

function gitWords(w: string[]): { sub: string; rest: string[]; globals: string[] } {
  // skip global options such as -C <dir> or --no-pager
  let i = 1;
  const globals: string[] = [];
  while (i < w.length && w[i].startsWith('-')) {
    globals.push(w[i]);
    if (GIT_VALUE_OPTIONS.has(w[i])) i++;
    i++;
  }
  return { sub: w[i] ?? '', rest: w.slice(i + 1), globals };
}

/**
 * Secrets by name, at any depth: keys and credentials, cloud and cluster sign-ins, shell and REPL history. The shell
 * sandbox (sandbox/profile.ts) refuses to read the same names, with the .env files and *.pem, *.p12, *.key.
 */
export const SECRET_NAMES = [
  '.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.docker/config.json', '.config/gh', '.config/gcloud', '.kube', '.azure',
  '.git-credentials', '.cargo/credentials', '.cargo/credentials.toml', '.terraform.d/credentials.tfrc.json', 'id_rsa', 'id_ed25519',
  '.zsh_history', '.zhistory', '.bash_history', '.sh_history', '.zsh_sessions', '.local/share/fish/fish_history',
  '.python_history', '.node_repl_history', '.irb_history', '.psql_history', '.mysql_history', '.sqlite_history',
];
const reEscape = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
const SECRET_PATH_RE = new RegExp(`(^|\\/)(${SECRET_NAMES.map(reEscape).join('|')}|\\.env(\\.(?!(example|sample|template|dist)(\\/|$))[\\w-]+)?|[^/]*\\.pem|[^/]*\\.p12|[^/]*\\.key)(\\/|$)`);
/** The app's own data under the home folder: sessions, and config.json with the provider keys */
export const APP_DATA = ['Library/Application Support/Silo Harness', 'Library/Application Support/Open Harness'];
/** Secrets under the home folder: the keychains and the browsers' profiles (cookies, saved passwords) */
export const SECRET_IN_HOME = [
  'Library/Keychains', 'Library/Cookies', 'Library/Safari',
  ...['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Canary', 'Chromium', 'BraveSoftware', 'Microsoft Edge', 'Arc', 'Vivaldi', 'com.operasoftware.Opera', 'Firefox'].map((b) => `Library/Application Support/${b}`),
];

/** a is b or a folder that holds b */
function holds(a: string, b: string): boolean {
  return a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/**
 * True when a path names keys or credentials: ~/.ssh, ~/.aws, .env files (not .env.example and the like), *.pem …,
 * or the app's own data (config.json holds provider keys) and the user's settings.json (its env block may).
 */
export function isSecretPath(p: string, cwd = '/'): boolean {
  const e = expandHome(p);
  if (SECRET_PATH_RE.test(e)) return true;
  const abs = path.resolve(cwd, e);
  const h = os.homedir();
  if ([...APP_DATA, ...SECRET_IN_HOME].some((d) => holds(path.join(h, d), abs))) return true;
  for (const dir of [configDir(), path.join(h, '.silo-harness'), path.join(h, '.open-harness')]) if (abs === path.join(dir, 'settings.json')) return true;
  return false;
}

/** Why a walk of the home folder, /, /Users or /Volumes asks: macOS raises a row of privacy prompts in the app's name */
export const SCAN_REASON = 'scans the home folder';

/** True for a folder whose walk reaches the folders macOS guards: the home folder (any /Users/<name>), ~/Library, /, /Users, /Volumes. */
function isScanRoot(abs: string): boolean {
  const h = os.homedir();
  return abs === '/' || abs === '/Users' || abs === '/Volumes' || abs === h || abs === path.join(h, 'Library') || path.dirname(abs) === '/Users';
}

/**
 * True when walking `p` (from `cwd`) walks the home folder, ~/Library, /, /Users or /Volumes, or every child of one
 * (`~/*`, `*` in the home folder). A named folder in it (~/Desktop, ~/projects) is not: macOS's own prompt names it.
 */
export function isHomeScanRoot(p: string, cwd: string): boolean {
  const e = expandHome(p);
  const base = e === '*' ? '.' : e.endsWith('/*') ? e.slice(0, -2) || '/' : e;
  return isScanRoot(path.resolve(cwd, base));
}

/**
 * A command's operands and option values: short clusters (-rn) and `--long=value` read, a value taken from the rest of
 * the cluster or the next word for the letters in `shortValue` and the names in `longValue`; after `--` all are operands.
 */
function operands(args: string[], shortValue: string, longValue: string[] = []): { ops: string[]; values: Map<string, string[]> } {
  const ops: string[] = [];
  const values = new Map<string, string[]>();
  const put = (k: string, v: string | undefined) => values.set(k, [...(values.get(k) ?? []), v ?? '']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      ops.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (eq > 0) put(name, a.slice(eq + 1));
      else if (longValue.includes(name)) put(name, args[++i]);
      else put(name, '');
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (!shortValue.includes(c)) {
          put('-' + c, '');
          continue;
        }
        put('-' + c, j + 1 < a.length ? a.slice(j + 1) : args[++i]);
        break;
      }
      continue;
    }
    ops.push(a);
  }
  return { ops, values };
}

/** A depth option's value (fd -d 1, tree -L 1, find -maxdepth 1) is 1 or less */
const shallow = (v: string[] | undefined): boolean => !!v && v.some((x) => /^\d+$/.test(x) && Number(x) <= 1);

/**
 * True when a simple command walks a folder recursively whose root is the home folder, /, /Users, /Volumes or
 * ~/Library (isHomeScanRoot): find, fd, grep -r, rg, ag, ack, tree and du, ls -R. With no folder named it walks the
 * working directory. A depth limit of 1 (find -maxdepth 1, fd -d 1, tree -L 1) lists one level only; du always walks.
 */
function scansHome(prog: string, args: string[], cwd: string): boolean {
  let roots: string[];
  switch (prog) {
    case 'find': {
      // options (-H -L -P -E -X -s -x, -f path), then the starting points, then the expression
      let i = 0;
      const starts: string[] = [];
      while (i < args.length && /^-[HLPEXsxd]+$/.test(args[i])) i++;
      for (; i < args.length; i++) {
        if (args[i] === '-f') starts.push(args[++i] ?? '');
        else if (args[i].startsWith('-') || args[i] === '(' || args[i] === '!') break;
        else starts.push(args[i]);
      }
      const max = args.indexOf('-maxdepth');
      if (max >= 0 && shallow([args[max + 1]])) return false;
      roots = starts.length ? starts : ['.'];
      break;
    }
    case 'fd':
    case 'fdfind': {
      const { ops, values } = operands(args, 'edtEcjSoxX', ['--extension', '--type', '--exclude', '--max-depth', '--min-depth', '--exact-depth', '--color', '--threads', '--size', '--changed-within', '--changed-before', '--owner', '--base-directory', '--search-path', '--path-separator', '--max-results', '--ignore-file', '--exec', '--exec-batch', '--batch-size', '--format']);
      if (shallow(values.get('-d')) || shallow(values.get('--max-depth')) || shallow(values.get('--exact-depth'))) return false;
      roots = [...ops.slice(1), ...(values.get('--search-path') ?? []), ...(values.get('--base-directory') ?? [])];
      break;
    }
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
    case 'ag':
    case 'ack': {
      const isGrep = prog.endsWith('grep');
      const { ops, values } = isGrep
        ? operands(args, 'efmABCdD', ['--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context', '--directories', '--devices', '--include', '--exclude', '--exclude-dir', '--label', '--color', '--colour'])
        : operands(args, prog === 'rg' ? 'ABCefgmMtTjEdr' : 'ABCGgmp', ['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-columns', '--threads', '--encoding', '--replace', '--max-depth', '--maxdepth', '--depth', '--context', '--after-context', '--before-context', '--color', '--colors', '--sort', '--sortr', '--type-add', '--path-to-ignore', '--ignore', '--ignore-dir', '--file-search-regex']);
      if (isGrep && !(values.has('-r') || values.has('-R') || values.has('--recursive') || values.has('--dereference-recursive') || (values.get('-d') ?? values.get('--directories') ?? []).includes('recurse'))) return false;
      if ((prog === 'rg' && shallow(values.get('-d'))) || shallow(values.get('--max-depth')) || shallow(values.get('--maxdepth')) || shallow(values.get('--depth'))) return false;
      // the pattern comes first unless -e/-f gave it (rg --files lists, it takes no pattern)
      const given = values.has('-e') || values.has('-f') || values.has('--regexp') || values.has('--file') || values.has('--files') || (!isGrep && prog !== 'rg' && values.has('-g'));
      roots = given ? ops : ops.slice(1);
      break;
    }
    case 'tree': {
      const { ops, values } = operands(args, 'LPIoHT', ['--filelimit', '--charset', '--timefmt', '--sort']);
      if (shallow(values.get('-L'))) return false;
      roots = ops;
      break;
    }
    case 'du':
      roots = operands(args, 'BdIt', ['--max-depth', '--threshold', '--exclude', '--block-size']).ops;
      break;
    case 'ls': {
      const { ops, values } = operands(args, '', []);
      if (values.has('-R') || values.has('--recursive')) {
        roots = ops;
        break;
      }
      // ls ~/* lists what is inside every folder in home (Desktop, Documents …); ls -d names them only
      return !values.has('-d') && !values.has('--directory') && ops.some((o) => o.endsWith('*') && isHomeScanRoot(o, cwd));
    }
    default:
      return false;
  }
  if (!roots.length) roots = ['.'];
  return roots.some((r) => isHomeScanRoot(r, cwd));
}

/** What a simple command does that raises a macOS privacy prompt (screen, camera, microphone, clipboard), or null */
function privacyReason(prog: string, args: string[]): string | null {
  if (prog === 'screencapture') return 'records the screen';
  if (prog === 'imagesnap' || prog === 'rec') return 'uses the camera or microphone';
  if (['ffmpeg', 'ffplay', 'ffprobe'].includes(prog) && args.some((a) => a.includes('avfoundation'))) return 'uses the camera or microphone';
  if (prog === 'sox' && args.some((a) => a === '-d' || a === '--default-device')) return 'uses the camera or microphone';
  if (prog === 'pbpaste') return 'reads the clipboard';
  return null;
}

/** Inside the working directory: what configures git, editors, CI, direnv, the app or another agent */
const PROTECTED_IN_PROJECT = ['.git', '.silo-harness', '.open-harness', '.claude', '.vscode', '.idea', '.husky', '.github/workflows', '.mcp.json', '.envrc', '.gitmodules'];
/** …except the folders in them that hold skills, commands, agents or worktrees, no executable configuration */
const OPEN_IN_PROJECT = ['.claude/skills', '.claude/commands', '.claude/agents', '.claude/worktrees', '.silo-harness/skills', '.open-harness/skills'];
/** Under the home folder: shell start-up files, git and ripgrep config, keys and credentials, launch agents */
const PROTECTED_IN_HOME = ['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.gitconfig', '.config/git', '.ripgreprc', '.ssh', '.aws', '.gnupg', '.netrc', '.npmrc', '.config/gh', 'Library/LaunchAgents'];
/** In the user's config folder (~/.silo-harness): skills and the instructions file hold no executable configuration */
const OPEN_IN_CONFIG = ['skills', 'SILOHARNESS.md', 'OPENHARNESS.md'];
/** The app's data folder (config.json, with every project's saved rules), when the app has told the guard (index.ts) */
let appDataDir: string | null = null;
export function setAppDataDir(dir: string | null): void {
  appDataDir = dir ? path.resolve(dir) : null;
}

/** The real path of `p`, or of its nearest existing folder with the rest appended */
function realish(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return p;
      rest.push(path.basename(cur));
      cur = up;
    }
  }
  return p;
}

/**
 * The files that hold permission rules: the user's settings.json (under every name the config folder has had) and
 * the app's config.json (each project's saved rules). The agent must never write them itself.
 */
export function ruleFiles(): string[] {
  const h = os.homedir();
  const out = [configDir(), path.join(h, '.silo-harness'), path.join(h, '.open-harness')].map((d) => path.join(d, 'settings.json'));
  for (const d of APP_DATA) out.push(path.join(h, d, 'config.json'));
  if (appDataDir) out.push(path.join(appDataDir, 'config.json'));
  return [...new Set(out.map((f) => path.resolve(f)))];
}

/** True when a write to `p` (from `cwd`) writes a file that holds permission rules, or moves or removes the folder it is in. Symlinks are followed. */
export function writesRuleFile(p: string, cwd: string): boolean {
  if (!p) return false;
  const abs = path.resolve(cwd, expandHome(p));
  const real = realish(abs);
  // The file itself, or the folder that holds it (moved or removed): not every folder above it, whose removal the
  // guard's own reasons (a critical folder, a broad path) already ask about
  return ruleFiles().some((f) => [f, realish(f)].some((t) => [abs, real].some((x) => x === t || x === path.dirname(t))));
}

/** True when a shell command writes, moves or removes a file that holds permission rules (as far as its text shows). */
export function commandWritesRuleFile(command: string, cwd: string): boolean {
  const raw = command.trim();
  const folders = lineFolders(raw, cwd);
  for (const simple of lineCommands(raw)) {
    const { argv, lexed } = argvOf(simple);
    const prog = path.basename(argv[0] ?? '');
    for (const p of writtenOrLinked(prog, argv.slice(1), lexed)) {
      if (!p || NULL_DEVICES.has(p)) continue;
      if ((placements(p, folders) ?? []).some((abs) => writesRuleFile(abs, cwd))) return true;
    }
  }
  return false;
}

/** The reasons no allow rule or "for this session" answer covers */
export const PROTECTED_REASONS: ReadonlySet<string> = new Set(['writes a protected file', 'modifies the .git directory']);

/** True when the path's segments hold `name` (one or more segments, a/b) starting at some depth, in any case (APFS ignores case). */
function segmentsHold(segs: string[], name: string): boolean {
  const want = name.toLowerCase().split('/');
  for (let i = 0; i + want.length <= segs.length; i++) if (want.every((w, j) => segs[i + j].toLowerCase() === w)) return true;
  return false;
}

/**
 * Why a write to `abs`, a path inside `root`, is protected there at any depth (sub/.git, sub/.vscode/tasks.json), or
 * null: every .git; the protected names, unless the path is also in an open folder (.claude/skills …). The shell
 * sandbox's profile (sandbox/profile.ts) refuses the same writes.
 */
function protectedInProject(file: string, root: string): string | null {
  if (!holds(root, file) || file === root) return null;
  const segs = path.relative(root, file).split(path.sep);
  if (segmentsHold(segs, '.git')) return 'modifies the .git directory';
  if (PROTECTED_IN_PROJECT.some((p) => segmentsHold(segs, p)) && !OPEN_IN_PROJECT.some((p) => segmentsHold(segs, p))) return 'writes a protected file';
  return null;
}

/**
 * Why a write to `abs` (resolved from `cwd`) is protected, or null. Inside the working directory, at any depth: .git,
 * the app's and other tools' project folders (not their skills, commands, agents or worktrees), .github/workflows,
 * .husky, .envrc, .gitmodules, .mcp.json. Anywhere: shell start-up files, git config, keys and credentials, launch
 * agents, the app's own data and the user's config folder (not its skills and instructions).
 */
export function protectedWrite(abs: string, cwd: string): string | null {
  const file = path.resolve(cwd, expandHome(abs));
  const root = path.resolve(cwd);
  // The files that hold permission rules, wherever the session works (even inside the config folder)
  if (writesRuleFile(file, cwd)) return 'writes a protected file';
  const inProject = protectedInProject(file, root);
  if (inProject) return inProject;
  const h = os.homedir();
  for (const dir of new Set([configDir(), path.join(h, '.silo-harness'), path.join(h, '.open-harness')])) {
    // (a session that works inside the config folder itself edits it freely: the tests' default folder is there)
    if (holds(dir, file) && !holds(dir, root) && !OPEN_IN_CONFIG.some((p) => holds(path.join(dir, p), file))) return 'writes a protected file';
  }
  for (const p of [...PROTECTED_IN_HOME, ...APP_DATA]) if (holds(path.join(h, p), file)) return 'writes a protected file';
  return null;
}

/** Programs whose last operand (or -t dir) is where they write: the destination, and the source's name inside it */
const COPY_PROGRAMS = new Set(['cp', 'mv', 'ln', 'rsync', 'install']);

/** The paths a simple command writes as far as its words show: redirections, cp/mv/ln/rsync/install destinations, tee, sed -i and rm operands. */
function writtenPaths(prog: string, args: string[], lexed: Lexed): string[] {
  const out = [...lexed.writes];
  const targets = args.filter((a) => !a.startsWith('-'));
  if (COPY_PROGRAMS.has(prog)) {
    const t = args.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
    const dest = t >= 0 ? (args[t].includes('=') ? args[t].split('=').slice(1).join('=') : args[t + 1]) : targets[targets.length - 1];
    const sources = t >= 0 ? targets.filter((x) => x !== dest) : targets.slice(0, -1);
    if (dest) {
      out.push(dest);
      for (const src of sources) out.push(path.join(dest, path.basename(src)));
    }
    if (prog === 'mv') out.push(...sources);
  }
  if (prog === 'tee' || prog === 'rm' || prog === 'rmdir' || prog === 'truncate') out.push(...targets);
  if (prog === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) out.push(...targets);
  if (prog === 'dd') for (const a of args) if (a.startsWith('of=')) out.push(a.slice(3));
  // where tar -C and unzip -d unpack: the folder itself (writesRuleFile answers for the folder that holds a rule file)
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (prog === 'tar') {
      if (a.startsWith('--directory=')) out.push(a.slice('--directory='.length));
      else if (a === '--directory' || /^-[A-Za-z]*C$/.test(a)) out.push(args[++i] ?? '');
    } else if (prog === 'unzip') {
      if (a === '-d') out.push(args[++i] ?? '');
      else if (/^-d./.test(a)) out.push(a.slice(2));
    }
  }
  return out;
}

/** writtenPaths, and what ln links to: a link to a rule file or a protected file is a way to write it */
function writtenOrLinked(prog: string, args: string[], lexed: Lexed): string[] {
  const out = writtenPaths(prog, args, lexed);
  if (prog === 'ln') {
    const ops = args.filter((a) => !a.startsWith('-'));
    const t = args.findIndex((a) => a === '-t' || a.startsWith('--target-directory'));
    const dest = t >= 0 ? (args[t].includes('=') ? args[t].split('=').slice(1).join('=') : args[t + 1]) : ops[ops.length - 1];
    out.push(...(t >= 0 ? ops.filter((x) => x !== dest) : ops.slice(0, -1)));
  }
  return out;
}

/** The operands a simple command writes that the outside check follows when relative: writtenPaths' operands, and mkdir and touch */
function writtenOperands(prog: string, args: string[], lexed: Lexed): string[] {
  const out = writtenPaths(prog, args, { ...lexed, writes: [] });
  if (prog === 'mkdir' || prog === 'touch') out.push(...args.filter((a) => !a.startsWith('-')));
  return out;
}

/** The paths an argument may name: itself, and what follows `@` or `=` (curl -d @file, -F key=@file, --file=x). */
function pathsIn(arg: string): string[] {
  const out = [arg];
  if (arg.startsWith('@')) out.push(arg.slice(1));
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const v = arg.slice(eq + 1);
    out.push(v.startsWith('@') ? v.slice(1) : v);
  }
  return out.filter(Boolean);
}

/** Programs that name a path without reading what is in it */
const NO_READ_PROGRAMS = new Set(['rm', 'rmdir', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'ls', 'stat', 'test', '[', 'du']);
const WRITE_PROGRAMS = new Set(['cp', 'mv', 'rm', 'mkdir', 'touch', 'ln', 'rsync', 'install', 'unzip', 'tar']);

/**
 * Why a shell command should pause for the user in auto mode, or null when it is routine development work
 * (builds, tests, git status/add/commit, file operations inside the working directory, package installs …).
 * Looks at every simple command, those inside substitutions, sh -c and eval strings and xargs / find -exec too.
 */
export function guardCommand(command: string, cwd: string): string | null {
  const raw = command.trim();
  if (!raw) return null;
  return guardLine(raw, cwd, lineFolders(raw, cwd), 0);
}

/**
 * guardCommand for a line, with the folders the whole line may be in. A path the guard can place is checked at every
 * one of them ("inside" is always the session's folder); a write it cannot place counts as outside.
 */
function guardLine(raw: string, cwd: string, folders: LineFolders, depth: number): string | null {
  if (/\b(curl|wget)\b[^|;&\n]*\|\s*(sudo\s+)?(sh|bash|zsh|ksh|dash|python3?|node|perl|ruby)\b/.test(raw)) return 'pipes a download into a shell';
  if (/\b(sh|bash|zsh)\s+-c\s+["']?\$\(\s*(curl|wget)\b/.test(raw)) return 'pipes a download into a shell';
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) return 'fork bomb';

  // A walk of the home folder or a privacy prompt (screen, camera, clipboard): kept until the whole line is read, so
  // a stronger reason anywhere in it (reads secrets, sudo, deletes …) comes first
  let soft: string | null = null;
  // Where a walk with no folder named starts: it follows a `cd` earlier in the line (cd ~ && find . -name x)
  let walkCwd = cwd;
  for (const simple of allSimpleCommands(raw)) {
    const { argv, lexed } = argvOf(simple);
    const prog = path.basename(argv[0] ?? '');
    const args = argv.slice(1);
    const flags = args.filter((a) => a.startsWith('-'));
    const targets = args.filter((a) => !a.startsWith('-'));
    // a protected file written by a redirection, cp, mv, tee, sed -i, rm, dd of=, or linked to by ln, at every
    // folder the line may be in
    for (const p of writtenOrLinked(prog, args, lexed)) {
      if (!p || NULL_DEVICES.has(p)) continue;
      for (const at of [p, ...(placements(p, folders) ?? [])]) {
        const why = protectedWrite(at, cwd);
        if (why) return why;
      }
    }
    // redirections: > path, 2> path, &> path, >| path (not 2>&1, >&2, /dev/null)
    if (pathArgsOutsideCwd(lexed.writes, cwd).length || writesOutside(lexed.writes, folders, cwd)) return 'writes outside the working directory';
    if (lexed.reads.some((t) => secretAt(t, folders))) return 'reads secrets';
    if (!prog) continue;

    // What sudo runs is read too: its own reason comes first ("uses sudo" saved as allowed must not wave through
    // sudo rm -rf ~); alwaysAskReason still asks "uses sudo"
    if (prog === 'sudo' || prog === 'doas') {
      const inner = depth < MAX_DEPTH ? sudoInner(argv) : null;
      return (inner && guardLine(inner, cwd, folders, depth + 1)) || 'uses sudo';
    }
    if (prog === 'rm') {
      const recursive = flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive');
      if (targets.some((t) => BROAD_TARGETS.has(t) || /^~?\/\*?$/.test(t))) return recursive ? 'recursive delete of a broad path' : 'deletes a broad path';
      const outside = pathArgsOutsideCwd(targets, cwd);
      if (outside.length) return 'deletes outside the working directory';
      if (recursive && targets.some((t) => /^\.\.(\/|$)/.test(t) || t === '~')) return 'recursive delete of a broad path';
      if (writesOutside(targets, folders, cwd)) return 'deletes outside the working directory';
    }
    if (prog === 'git') {
      const { sub, rest } = gitWords(argv);
      if (sub === 'push') return rest.some((a) => a === '-f' || a === '--force' || a.startsWith('--force')) ? 'force-pushes to a remote' : 'pushes to a remote';
      if (sub === 'reset' && rest.includes('--hard')) return 'destructive git (reset --hard)';
      if ((sub === 'checkout' || sub === 'restore') && rest.some((a) => a === '.' || a === '--' ) && rest.some((a) => a === '.')) return 'discards working-tree changes';
      if (sub === 'clean' && rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === '--force')) return 'discards untracked files (git clean)';
      if (sub === 'branch' && rest.includes('-D')) return 'deletes a branch';
      if (sub === 'stash' && rest.includes('drop')) return 'drops a stash';
    }
    if (['mkfs', 'dd', 'diskutil', 'fdisk', 'parted', 'newfs_hfs', 'newfs_apfs'].includes(prog) || /^mkfs\./.test(prog)) return 'disk operation';
    if (['shutdown', 'reboot', 'halt', 'launchctl', 'systemctl', 'killall', 'pkill'].includes(prog)) return 'system control';
    if (prog === 'crontab' && !(args.length === 1 && args[0] === '-l')) return 'system control';
    if (prog === 'kill' && flags.includes('-9') && targets.includes('-1')) return 'system control';
    if ((prog === 'chmod' || prog === 'chown' || prog === 'chgrp') && flags.some((f) => /^-[a-zA-Z]*R/.test(f) || f === '--recursive')) {
      if (targets.some((t) => BROAD_TARGETS.has(t)) || pathArgsOutsideCwd(targets, cwd).length || writesOutside(targets.slice(1), folders, cwd)) return 'broad permission change';
    }
    if (prog === 'osascript' || (prog === 'open' && (flags.includes('-a') || flags.includes('-b')))) return 'controls other apps';
    if (['ssh', 'scp', 'sftp', 'telnet'].includes(prog)) return 'remote access';
    if (prog === 'rsync' && targets.some((t) => /^[\w.-]+@[\w.-]+:|^[\w.-]+:[^/]/.test(t))) return 'remote access';
    if ((prog === 'npm' || prog === 'yarn' || prog === 'pnpm') && targets[0] === 'publish') return 'publishes a package';
    if (prog === 'cargo' && targets[0] === 'publish') return 'publishes a package';
    if ((prog === 'twine' && targets[0] === 'upload') || (prog === 'gem' && targets[0] === 'push')) return 'publishes a package';
    if (prog === 'gh' && ((targets[0] === 'release' && targets[1] !== 'list' && targets[1] !== 'view') || (targets[0] === 'pr' && (targets[1] === 'merge' || targets[1] === 'close')) || (targets[0] === 'repo' && targets[1] === 'delete'))) return 'publishes or merges on GitHub';
    // A recognised aws read (isAwsRead) is a plain read only when the whole line is one (isReadOnlyCommand): never
    // inside sh -c, xargs, find -exec or a substitution, nor next to a command that is not a read
    if (prog === 'aws' ? !(isAwsRead(simple) && isReadOnlyCommand(raw)) : ['gcloud', 'az', 'pulumi', 'flyctl', 'heroku', 'vercel', 'netlify'].includes(prog)) return 'cloud or infrastructure change';
    if (prog === 'kubectl' && ['apply', 'delete', 'rollout', 'scale', 'drain', 'cordon', 'patch', 'replace', 'exec'].includes(targets[0] ?? '')) return 'cloud or infrastructure change';
    if (prog === 'terraform' && ['apply', 'destroy', 'import', 'taint'].includes(targets[0] ?? '')) return 'cloud or infrastructure change';
    if (prog === 'helm' && ['install', 'upgrade', 'uninstall', 'delete', 'rollback'].includes(targets[0] ?? '')) return 'cloud or infrastructure change';
    if (prog === 'docker' || prog === 'podman') {
      const sub = targets[0] ?? '';
      if ((sub === 'system' && targets[1] === 'prune') || sub === 'rmi' || (sub === 'volume' && (targets[1] === 'rm' || targets[1] === 'prune')) || (sub === 'rm' && flags.some((f) => /^-[a-zA-Z]*f/.test(f) || f === '--force'))) return 'cloud or infrastructure change';
    }
    if ((prog === 'defaults' && targets[0] === 'write') || ['csrutil', 'spctl', 'tccutil', 'nvram', 'tmutil', 'pmset', 'networksetup', 'scutil', 'dscl'].includes(prog)) return 'changes macOS settings';
    if (prog === 'security' && targets.some((t) => /^(find|dump|export|delete|add)-/.test(t))) return 'reads or changes the keychain';
    if (prog === 'printenv' && !targets.length) return 'reads secrets';
    if (prog === 'env' && !targets.length && !flags.length) return 'reads secrets';
    if (!NO_READ_PROGRAMS.has(prog) && args.some((a) => pathsIn(a).some((p) => secretAt(p, folders)))) return 'reads secrets';
    if (prog === 'sed' && flags.some((f) => /^-[a-zA-Z]*i/.test(f) || f === '--in-place') && pathArgsOutsideCwd(targets, cwd).length) return 'writes outside the working directory';
    if (WRITE_PROGRAMS.has(prog) && pathArgsOutsideCwd(targets, cwd).length) return 'writes outside the working directory';
    if (prog === 'tee' && pathArgsOutsideCwd(targets, cwd).length) return 'writes outside the working directory';
    // what it writes, relative paths too, at every folder the line may be in (rm said so above)
    if (prog !== 'rm' && writesOutside(writtenOperands(prog, args, lexed), folders, cwd)) return 'writes outside the working directory';
    if ((prog === 'cd' || prog === 'pushd') && args[0] !== '-') walkCwd = path.resolve(walkCwd, expandHome(targets[0] ?? '~'));
    soft ??= privacyReason(prog, args) ?? (scansHome(prog, args, walkCwd) ? SCAN_REASON : null);
  }
  return soft;
}

/** Why a file write should pause for the user, or null when the file is inside the working directory. */
export function guardWrite(absPath: string, cwd: string): string | null {
  const abs = path.resolve(expandHome(absPath));
  if (!insideCwd(abs, cwd)) return 'writes outside the working directory';
  // every .git, at any depth (sub/.git/config), as the shell sandbox refuses it
  if (segmentsHold(path.relative(path.resolve(cwd), abs).split(path.sep), '.git')) return 'modifies the .git directory';
  return null;
}

/**
 * What the shell sandbox's profile (sandbox/profile.ts) is given from the guard's lists, for a session working in
 * `cwd`: secret names and paths it may not read, and the paths it may not write wherever they are (shell start-up
 * files, launch agents, keys, the app's data, the user's config folder unless the session works in it, the rule files
 * and the folders that hold them). Each path also as its real path, since the sandbox sees a symlink's target.
 */
export function sandboxGuardPaths(cwd: string): { secretNames: string[]; secretPaths: string[]; protectedPaths: string[]; protectedFolders: string[] } {
  const h = os.homedir();
  const root = path.resolve(cwd);
  const both = (list: string[]) => [...new Set(list.flatMap((p) => [path.resolve(p), realish(path.resolve(p))]))];
  const configs = [...new Set([configDir(), path.join(h, '.silo-harness'), path.join(h, '.open-harness')])];
  const data = [...APP_DATA.map((d) => path.join(h, d)), ...(appDataDir ? [appDataDir] : [])];
  const rules = ruleFiles();
  // (a path inside another one on the same list adds nothing)
  const outermost = (list: string[]) => list.filter((p) => !list.some((q) => q !== p && holds(q, p)));
  const protectedPaths = outermost(both([...PROTECTED_IN_HOME.map((p) => path.join(h, p)), ...data, ...configs.filter((d) => !holds(d, root)), ...rules]));
  return {
    secretNames: [...SECRET_NAMES],
    secretPaths: outermost(both([...data, ...SECRET_IN_HOME.map((d) => path.join(h, d)), ...configs.map((d) => path.join(d, 'settings.json'))])),
    protectedPaths,
    protectedFolders: both(rules.map((f) => path.dirname(f))).filter((d) => !protectedPaths.some((p) => holds(p, d))),
  };
}

const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'ag', 'find', 'fd', 'pwd', 'which', 'whereis', 'type', 'echo', 'printf', 'tree', 'du', 'df', 'stat', 'file',
  'date', 'uname', 'sw_vers', 'hostname', 'whoami', 'id', 'true', 'false', 'test', '[', 'sort', 'uniq', 'cut', 'awk', 'tr', 'diff', 'cmp', 'md5', 'shasum', 'jq', 'yq',
  'basename', 'dirname', 'realpath', 'readlink', 'column', 'nl', 'bat', 'sed', 'git', 'npm', 'pnpm', 'yarn', 'node', 'python3', 'python', 'pip', 'pip3',
  'cargo', 'go', 'rustc', 'java', 'ruby', 'php', 'perl', 'swift', 'xcodebuild', 'cmake', 'tsc', 'mdfind',
]);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'reflog', 'cat-file', 'grep', 'remote', 'config', 'rev-list', 'count-objects', 'branch', 'tag', 'stash', 'worktree', 'help', 'version']);
const PKG_READ_ONLY = new Set(['ls', 'list', 'view', 'info', 'outdated', 'audit', 'why', 'explain', 'show', 'search', 'help', 'version', '-v', '--version', 'config']);
/** A package as the registry names it (name, @scope/name, name@version) or a field of it (dist.tarball): no URL, path or git spec */
const PKG_SPEC = /^(@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(@[A-Za-z0-9._~^<>=*|-]*)?$/;
/** Git's global options that set config, or point it at other code or another repository */
const GIT_UNSAFE_GLOBAL = /^(-c|--config-env|--exec-path|--git-dir|--work-tree)(=|$)/;

/** A short-option cluster (-abc, not --long) that holds one of `letters` */
const shortHas = (a: string, letters: string): boolean => /^-[^-]/.test(a) && [...a.slice(1)].some((c) => letters.includes(c));
/** An option given as `--name` or `--name=value` */
const longIs = (a: string, ...names: string[]): boolean => names.some((n) => a === n || a.startsWith(n + '='));

/**
 * True when a sed script only prints or edits the stream: no w/W/e/r/R commands, no s///w or s///e flag. Anything it
 * cannot read is false.
 */
export function sedScriptReadOnly(script: string): boolean {
  const s = script;
  let i = 0;
  // Skips a delimited part from i (at the delimiter) and returns the index after its closing delimiter
  const delimited = (from: number, delim: string): number => {
    let j = from + 1;
    while (j < s.length && s[j] !== delim) j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  };
  while (i < s.length) {
    while (i < s.length && /[\s;{}!]/.test(s[i])) i++;
    if (i >= s.length) break;
    // addresses: 1, $, /re/, \cREc, ranges, steps
    while (i < s.length) {
      const c = s[i];
      if (/[0-9$,~+\s]/.test(c)) i++;
      else if (c === '/') i = delimited(i, '/');
      else if (c === '\\' && i + 1 < s.length) i = delimited(i + 1, s[i + 1]);
      else break;
      if (s[i] === 'I' || s[i] === 'M') i++;
    }
    while (i < s.length && /[\s!]/.test(s[i])) i++;
    const cmd = s[i];
    if (cmd === undefined) break;
    if (cmd === '{' || cmd === '}' || cmd === ';') {
      i++;
      continue;
    }
    if (cmd === 's' || cmd === 'y') {
      const delim = s[i + 1];
      if (!delim || delim === '\\' || delim === '\n') return false;
      i = delimited(i + 1, delim) - 1;
      i = delimited(i, delim);
      if (cmd === 's') {
        const flags = /^[gpiImMe0-9w]*/.exec(s.slice(i))?.[0] ?? '';
        if (/[we]/.test(flags)) return false;
        i += flags.length;
      }
      continue;
    }
    if ('pPdDnNgGhHxlz=Fv'.includes(cmd)) {
      i++;
      continue;
    }
    if (cmd === 'q' || cmd === 'Q') {
      i++;
      while (i < s.length && /[0-9]/.test(s[i])) i++;
      continue;
    }
    if ('bt:T'.includes(cmd) || cmd === '#' || 'aic'.includes(cmd)) {
      // a label, a comment or text: to the end of the line (or the ; for a label)
      const stop = 'bt:T'.includes(cmd) ? /[;\n]/ : /\n/;
      i++;
      while (i < s.length && !stop.test(s[i])) i++;
      continue;
    }
    return false; // w W e r R, or something this does not know
  }
  return true;
}

/** True when an awk program text only reads: no system(), pipes, output redirection or getline. */
function awkTextReadOnly(text: string): boolean {
  return !/system|\||>|getline/.test(text);
}

/** False when a read-only program's arguments make it write or run something. */
function readOnlyArgs(prog: string, argv: string[]): boolean {
  const args = argv.slice(1);
  const flags = args.filter((a) => a.startsWith('-'));
  const targets = args.filter((a) => !a.startsWith('-'));
  switch (prog) {
    case 'sed': {
      if (flags.some((f) => longIs(f, '--in-place', '--file') || shortHas(f, 'if'))) return false;
      const scripts: string[] = [];
      let sawE = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-e' || args[i] === '--expression') {
          sawE = true;
          scripts.push(args[++i] ?? '');
        } else if (args[i].startsWith('--expression=')) {
          sawE = true;
          scripts.push(args[i].slice('--expression='.length));
        } else if (/^-[^-]*e./.test(args[i])) {
          sawE = true;
          scripts.push(args[i].slice(args[i].indexOf('e') + 1));
        }
      }
      if (!sawE) scripts.push(targets[0] ?? '');
      return scripts.every(sedScriptReadOnly);
    }
    case 'awk':
      if (flags.some((f) => shortHas(f, 'fiE') || longIs(f, '--file', '--include', '--exec', '--load'))) return false;
      return args.every(awkTextReadOnly);
    case 'sort':
      return !flags.some((f) => /^-[^-]*o/.test(f) || longIs(f, '--output', '--compress-program'));
    case 'tree':
      return !flags.some((f) => shortHas(f, 'oR'));
    case 'uniq': {
      let operands = 0;
      for (let i = 0; i < args.length; i++) {
        if (['-f', '-s', '-w'].includes(args[i])) i++;
        else if (!args[i].startsWith('-') || args[i] === '-') operands++;
      }
      return operands < 2;
    }
    case 'find':
      return !args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(a));
    case 'fd':
      return !flags.some((f) => shortHas(f, 'xX') || longIs(f, '--exec', '--exec-batch'));
    case 'bat':
      return !flags.some((f) => longIs(f, '--pager'));
    case 'ag':
      return !flags.some((f) => longIs(f, '--pager'));
    case 'yq':
      return !flags.some((f) => longIs(f, '--inplace') || shortHas(f, 'i'));
    case 'file':
      return !flags.some((f) => shortHas(f, 'C') || longIs(f, '--compile'));
    case 'hostname':
      return targets.length === 0;
    case 'mdfind':
      return !args.includes('-live');
    case 'rg':
      return !flags.some((f) => longIs(f, '--pre', '--pre-glob', '--hostname-bin'));
    case 'tsc':
      return flags.includes('--noEmit') && !flags.some((f) => longIs(f, '--generateTrace', '--generateCpuProfile', '--build') || f === '-b' || f === '-w' || f === '--watch');
    case 'git': {
      const { sub, rest, globals } = gitWords(argv);
      if (globals.some((g) => GIT_UNSAFE_GLOBAL.test(g))) return false;
      if (!GIT_READ_ONLY.has(sub)) return false;
      if (rest.some((a) => longIs(a, '--output', '--ext-diff', '--textconv', '--filters'))) return false;
      if (sub === 'grep' && rest.some((a) => longIs(a, '--open-files-in-pager') || /^-O/.test(a) || shortHas(a, 'O'))) return false;
      if (sub === 'help' && rest.some((a) => a === '-w' || a === '--web')) return false;
      if (sub === 'branch' && rest.some((a) => /^-[a-zA-Z]*[dDmMcC]/.test(a) || !a.startsWith('-'))) return false; // creating/deleting/renaming
      if (sub === 'tag' && rest.some((a) => !a.startsWith('-') || /^-[a-zA-Z]*[dfa]/.test(a))) return false;
      if (sub === 'stash' && rest[0] !== 'list' && rest[0] !== 'show') return false;
      if (sub === 'remote' && rest.length && rest[0] !== '-v' && rest[0] !== 'show' && rest[0] !== 'get-url') return false;
      if (sub === 'config' && !rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-all')) return false;
      if (sub === 'worktree' && rest[0] !== 'list') return false;
      // (reflog expire and reflog delete drop entries)
      if (sub === 'reflog' && rest.some((a) => a === 'expire' || a === 'delete')) return false;
      return true;
    }
    case 'npm':
    case 'pnpm':
    case 'yarn': {
      const sub = targets[0] ?? flags[0] ?? '';
      if (!PKG_READ_ONLY.has(sub)) return false;
      // Another registry, proxy, config file or shell: the request, and what runs, would no longer be the user's own
      if (flags.some((f) => longIs(f, '--registry', '--userconfig', '--globalconfig', '--proxy', '--https-proxy', '--noproxy', '--cafile', '--ca', '--script-shell', '--shell', '--node-options'))) return false;
      // view reads a package from the registry by name; a URL, a path or a git spec is fetched (and may be built)
      if (['view', 'info', 'show'].includes(sub) && !targets.slice(targets[0] === sub ? 1 : 0).every((t) => PKG_SPEC.test(t))) return false;
      if (sub === 'config') return ['get', 'list', 'ls'].includes(targets[1] ?? '');
      if (sub === 'audit') return !args.some((a) => a === 'fix' || a === '--fix');
      if (sub === 'version') return prog === 'npm' && args.length === 1;
      return true;
    }
    case 'pip':
    case 'pip3': {
      const sub = targets[0] ?? flags[0] ?? '';
      if (!['list', 'show', 'freeze', '--version', '-V', 'check'].includes(sub)) return false;
      // --log writes a file, --python runs another interpreter, the rest send the request somewhere else
      if (flags.some((f) => longIs(f, '--log', '--python', '--cache-dir', '--index-url', '--extra-index-url', '--proxy', '--find-links', '--trusted-host', '--cert', '--client-cert', '--keyring-provider'))) return false;
      // -i is --index-url; -f is --find-links everywhere but in `pip show`, where it lists the package's files
      return !flags.some((f) => shortHas(f, sub === 'show' ? 'i' : 'if'));
    }
    case 'cargo': {
      const sub = targets[0] ?? flags[0] ?? '';
      if (!['tree', 'metadata', 'version', '--version', '-V', 'search'].includes(sub)) return false;
      return !(sub === 'search' && flags.some((f) => longIs(f, '--registry', '--index')));
    }
    case 'go': {
      const sub = targets[0] ?? flags[0] ?? '';
      if (!['version', 'env', 'list', 'doc'].includes(sub)) return false;
      return !(sub === 'env' && flags.some((f) => f === '-w' || f === '-u'));
    }
    case 'node':
    case 'python3':
    case 'python':
    case 'ruby':
    case 'php':
    case 'perl':
    case 'java':
    case 'swift':
    case 'rustc':
      return args.every((a) => /^(-v|--version|-V|-version)$/.test(a));
    case 'xcodebuild':
      return flags.includes('-list') || flags.includes('-version') || flags.includes('-showsdks');
    case 'cmake':
      return flags.includes('--version');
    default:
      return true;
  }
}

// ---------- Recognised read-only aws commands ----------
// The one definition of "a recognised aws read": isReadOnlyCommand runs it as it runs ls, and guardCommand then gives
// it no "cloud or infrastructure change" reason. Anything this does not positively recognise stays as before.

/**
 * The words of a simple command, read strictly, or null when a shell could read it differently from this: only
 * printable ASCII; unquoted, only letters, digits and _ . / : @ , + = - (no $ ` \ * ? [ ] { } ~ # ! ( ) < > | ; & %);
 * a word may not start with an unquoted = (zsh's =cmd); single quotes are literal; double quotes may not hold
 * $ ` \ or !; no empty word, no unclosed quote.
 */
function strictWords(s: string): string[] | null {
  if (/[^\x20-\x7e\t]/.test(s)) return null;
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ' ' || s[i] === '\t') {
      i++;
      continue;
    }
    if (s[i] === '=') return null;
    let cur = '';
    while (i < s.length && s[i] !== ' ' && s[i] !== '\t') {
      const c = s[i];
      if (c === "'" || c === '"') {
        const end = s.indexOf(c, i + 1);
        if (end < 0) return null;
        const body = s.slice(i + 1, end);
        if (c === '"' && /[$`\\!]/.test(body)) return null;
        cur += body;
        i = end + 1;
        continue;
      }
      if (!/[A-Za-z0-9_./:@,+=-]/.test(c)) return null;
      cur += c;
      i++;
    }
    if (!cur) return null;
    out.push(cur);
  }
  return out;
}

/** A CLI command or operation name: lower case, single dashes */
const AWS_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Words in an operation's name that mark a credential, a secret, a login, a session, a signed URL or a download */
const AWS_SECRET_WORDS = ['token', 'credential', 'password', 'secret', 'login', 'api-key', 'access-details', 'session', 'presign', 'embed', 'download', 'decrypt', 'private-key', 'export'];
/**
 * Read-looking operations that are not plain reads: they return a secret, key material, environment variables or a
 * signed URL, have a side effect (cognito-identity get-id creates an identity), or write their result to a local file
 * (streaming output: the CLI takes an outfile argument).
 */
const AWS_REFUSED_OPS = new Set([
  // secrets, credentials, keys
  'secretsmanager get-secret-value', 'secretsmanager batch-get-secret-value', 'secretsmanager get-random-password',
  'ecr get-login-password', 'ecr get-authorization-token', 'ecr-public get-login-password', 'ecr-public get-authorization-token',
  'codeartifact get-authorization-token', 'sts get-session-token', 'sts get-federation-token', 'eks get-token',
  'sso get-role-credentials', 'redshift get-cluster-credentials', 'redshift get-cluster-credentials-with-iam', 'redshift-serverless get-credentials',
  'lightsail get-instance-access-details', 'lightsail get-relational-database-master-user-password', 'ec2 get-password-data',
  'cognito-identity get-credentials-for-identity', 'cognito-identity get-open-id-token', 'cognito-identity get-id',
  'cognito-idp describe-user-pool-client', 'cognito-idp describe-identity-provider',
  'appsync list-api-keys', 'apigateway get-api-key', 'apigateway get-api-keys', 'iam get-credential-report',
  'glue get-connection', 'glue get-connections', 'ivs get-stream-key', 'ivs batch-get-stream-key', 'kms get-parameters-for-import',
  // environment variables, user data, configuration that often holds secrets
  'lambda get-function', 'lambda get-function-configuration', 'lambda get-layer-version', 'lambda get-layer-version-by-arn',
  'ecs describe-task-definition', 'batch describe-job-definitions', 'apprunner describe-service',
  'amplify get-app', 'amplify get-branch', 'amplify list-apps', 'amplify list-branches', 'amplify get-backend-environment',
  'elasticbeanstalk describe-configuration-settings', 'ec2 describe-instance-attribute', 'ec2 describe-launch-template-versions',
  'ec2 get-launch-template-data', 'autoscaling describe-launch-configurations', 'glue get-job', 'glue get-jobs',
  'sagemaker describe-model', 'sagemaker describe-training-job', 'sagemaker describe-processing-job', 'sagemaker describe-transform-job',
  // signed URLs
  'ecr get-download-url-for-layer', 'gamelift get-game-session-log-url',
  // the result goes to a local file (an outfile argument)
  's3api get-object', 's3api get-object-torrent', 'cloudfront get-function', 'apigateway get-sdk', 'glacier get-job-output',
  'mediastore-data get-object', 'kinesis-video-media get-media', 'kinesis-video-archived-media get-clip',
  'kinesis-video-archived-media get-media-for-fragment-list', 'ebs get-snapshot-block', 'iot-data get-thing-shadow',
  'codeartifact get-package-version-asset', 'lakeformation get-work-unit-results', 'backupstorage get-chunk',
  'backupstorage get-object-metadata', 'omics get-read-set', 'omics get-reference', 'sagemaker-geospatial get-tile',
  'workmailmessageflow get-raw-message-content', 'appconfig get-configuration', 'appconfigdata get-latest-configuration',
  // Added after review. From memory, not checked against the real CLI, and not complete: AWS_READ_SERVICES is the
  // first line of defence, this list the second.
  // credentials by design, or configuration that commonly embeds secrets (environment, user data, job arguments)
  'ec2 describe-vpn-connections', 'ec2 get-vpn-connection-device-sample-configuration', 'ec2 describe-spot-fleet-requests',
  'ec2 describe-spot-instance-requests', 'ec2 describe-verified-access-trust-providers',
  'ecs describe-tasks', 'ecs describe-express-gateway-service', 'batch describe-jobs',
  'apigateway get-usage-plan-key', 'apigateway get-usage-plan-keys', 'apigateway get-export',
  'codepipeline get-job-details', 'codepipeline get-third-party-job-details', 'codepipeline list-webhooks',
  'glue get-job-run', 'glue get-job-runs', 'glue get-trigger', 'glue get-triggers', 'glue get-workflow', 'glue get-workflow-run',
  'glue get-workflow-runs', 'glue get-dev-endpoint', 'glue get-dev-endpoints',
  'ssm get-deployable-patch-snapshot-for-instance', 'athena get-resource-dashboard', 'cloudfront get-connection-function',
  // a side effect: takes a task off the queue
  'stepfunctions get-activity-task',
  // the result goes to a local file
  'logs get-log-object', 'appsync get-introspection-schema', 'schemas get-code-binding-source', 'appconfig get-hosted-configuration-version',
  'medialive describe-input-device-thumbnail', 'codeguruprofiler get-profile', 'location get-map-glyphs', 'location get-map-sprites',
  'location get-map-style-descriptor', 'location get-map-tile', 'geo-maps get-glyphs', 'geo-maps get-sprites', 'geo-maps get-static-map',
  'geo-maps get-style-descriptor', 'geo-maps get-tile', 'medical-imaging get-image-frame', 'medical-imaging get-image-set-metadata',
  'tnb get-sol-function-package-content', 'tnb get-sol-function-package-descriptor', 'tnb get-sol-network-package-content',
  'tnb get-sol-network-package-descriptor', 'iotwireless get-position-estimate', 'iotwireless get-resource-position',
]);
/**
 * The services whose get-, list- and describe- operations may be reads: default-deny, so a service not named here
 * (cloudcontrol, configservice, sagemaker, appsync, cognito-*, gamelift, lightsail …) goes to the check or a card.
 */
const AWS_READ_SERVICES = new Set([
  'sts', 'iam', 'organizations', 'ec2', 'autoscaling', 'application-autoscaling', 'elb', 'elbv2', 's3api', 'lambda', 'ecs', 'eks', 'ecr',
  'batch', 'apprunner', 'elasticbeanstalk', 'logs', 'cloudwatch', 'cloudtrail', 'xray', 'events', 'scheduler', 'health', 'cloudformation',
  'ssm', 'kms', 'acm', 'rds', 'dynamodb', 'dynamodbstreams', 'elasticache', 'redshift', 'opensearch', 'es', 'sqs', 'sns', 'kinesis',
  'stepfunctions', 'apigateway', 'apigatewayv2', 'cloudfront', 'route53', 'wafv2', 'athena', 'glue', 'codebuild', 'codepipeline',
  'codedeploy', 'codecommit', 'bedrock', 'efs', 'fsx', 'backup', 'service-quotas', 'resourcegroupstaggingapi', 'pricing', 'budgets',
  'guardduty', 'securityhub', 'ses', 'sesv2',
]);
/**
 * Whole services left to the check: the CLI's own commands (configure, s3 and history are customisations, apart from
 * the reads named in AWS_EXPLICIT_READS), Cost Explorer (each request is billed), and sign-in.
 */
const AWS_REFUSED_SERVICES = new Set(['configure', 's3', 'history', 'ce', 'sso', 'sso-oidc', 'secretsmanager']);
/** Reads by explicit name, outside the get-, list- and describe- shapes or the refused services */
const AWS_EXPLICIT_READS = new Set(['sts get-caller-identity', 's3 ls', 's3api head-object', 's3api head-bucket', 'configure list', 'configure list-profiles']);
/** Global options that take a value, and the value each takes */
const AWS_GLOBAL_VALUES: Record<string, RegExp> = {
  '--profile': /^[A-Za-z0-9_.@+][A-Za-z0-9_.@+-]{0,63}$/,
  '--region': /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/,
  '--output': /^(json|text|table|yaml|yaml-stream)$/,
  '--color': /^(on|off|auto)$/,
  '--query': /^[^-]/,
};
const AWS_GLOBAL_FLAGS = new Set(['--no-cli-pager', '--no-paginate']);
/** Pagination options, after the operation */
const AWS_PAGING_VALUES: Record<string, RegExp> = {
  '--max-items': /^\d{1,9}$/,
  '--page-size': /^\d{1,9}$/,
  '--starting-token': /^[A-Za-z0-9+/=_.:-]+$/,
};
/**
 * Options never allowed, nor any abbreviation of one (the CLI's parser accepts an unambiguous prefix: --endpoint is
 * --endpoint-url): another endpoint, an input file, TLS changes, debug output, a skeleton instead of the call, and
 * ssm's --with-decryption.
 */
const AWS_REFUSED_OPTIONS = [
  '--endpoint-url', '--cli-input-json', '--cli-input-yaml', '--ca-bundle', '--no-verify-ssl', '--debug', '--generate-cli-skeleton',
  '--cli-auto-prompt', '--no-cli-auto-prompt', '--cli-binary-format', '--cli-read-timeout', '--cli-connect-timeout', '--no-sign-request',
  '--with-decryption', '--version',
];
/** An operation option's name may not hold these (an input or output file, a secret); pagination tokens are fine */
const AWS_REFUSED_OPTION_WORDS = /file|password|secret|credential|decrypt|token/;
const AWS_PAGINATION_TOKENS = new Set(['--next-token', '--continuation-token', '--starting-token']);
/** A value that makes the CLI read a local file or fetch a URL */
const AWS_LOADS = /(file|fileb|https?):\/\//i;
/** s3 ls's own flags, and the one location it lists */
const AWS_S3_LS_FLAGS = new Set(['--recursive', '--human-readable', '--summarize']);
const AWS_S3_URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{0,62}(\/[^\s]*)?$|^s3:\/\/$/;
/**
 * lambda list-functions returns each function's environment variables; it passes only with a --query that keeps a few
 * named fields: Functions[].Name, Functions[].[A,B] or Functions[].{K:A,…}.
 */
const AWS_LAMBDA_LISTS: Record<string, string> = { 'lambda list-functions': 'Functions', 'lambda list-versions-by-function': 'Versions' };
const LAMBDA_FIELDS = 'FunctionName|FunctionArn|Runtime|Handler|CodeSize|Description|Timeout|MemorySize|LastModified|CodeSha256|Version|PackageType|Architectures|State|LastUpdateStatus|RevisionId';

function lambdaQueryKeepsFields(list: string, query: string | undefined): boolean {
  if (query === undefined) return false;
  const q = query.replace(/\s+/g, '');
  const f = `(?:${LAMBDA_FIELDS})`;
  const k = '[A-Za-z][A-Za-z0-9_]*';
  return new RegExp(`^${list}\\[\\*?\\]\\.(?:${f}|\\[${f}(?:,${f})*\\]|\\{${k}:${f}(?:,${k}:${f})*\\})$`).test(q);
}

/** The global and paging options this reader knows: each must be written in full */
const AWS_KNOWN_OPTIONS = [...Object.keys(AWS_GLOBAL_VALUES), ...AWS_GLOBAL_FLAGS, ...Object.keys(AWS_PAGING_VALUES)];

/**
 * An option name the CLI could read as another one: a refused option or a prefix of one, or a proper prefix of a known
 * option (the CLI takes --no-pag as --no-paginate, a flag, and the next word would be a positional output file).
 */
function awsRefusedOption(name: string): boolean {
  return AWS_REFUSED_OPTIONS.some((r) => r.startsWith(name)) || name.startsWith('--cli-') || AWS_KNOWN_OPTIONS.some((k) => k !== name && k.startsWith(name));
}

/**
 * True when a simple command is a recognised read-only aws command: `aws`, then allowed global options (in full), then a
 * service in AWS_READ_SERVICES and an operation that reads by name (get-*, list-*, describe-*), or one of
 * AWS_EXPLICIT_READS, and is not refused (a
 * secret, a credential, a signed URL, a side effect, an output file), then its own `--name value` options and the
 * allowed global ones. No positional argument but s3 ls's one s3:// location, no value that loads a file or URL, no
 * option repeated. `aws --version`, `aws help`, `aws <service> help` and `aws <service> <operation> help` read too.
 * The words must read the same to this strict reader and to lex(): no expansion, glob, redirection or escape.
 */
export function isAwsRead(simple: string): boolean {
  // The redirections that write nothing (2>&1, >&2, 2>/dev/null, &>/dev/null) are taken out first; lex() must agree
  const bare = simple.replace(/(^|[ \t])(?:[12]?>&[12]|(?:[12&]?>)[ \t]?\/dev\/null)(?=[ \t]|$)/g, '$1');
  const w = strictWords(bare.trim());
  if (!w || w[0] !== 'aws') return false;
  const lexed = lex(simple);
  if (lexed.writes.some((t) => t !== '/dev/null') || lexed.reads.length || lexed.words.length !== w.length || lexed.words.some((x, k) => x !== w[k])) return false;
  if (w.some((x) => AWS_LOADS.test(x))) return false;
  if (w.length === 2 && (w[1] === '--version' || w[1] === 'help')) return true;
  if (w.length === 3 && AWS_NAME.test(w[1]) && w[2] === 'help') return true;
  if (w.length === 4 && AWS_NAME.test(w[1]) && AWS_NAME.test(w[2]) && w[3] === 'help') return true;

  const seen = new Set<string>();
  const values = new Map<string, string>();
  // One option at i (a name, `--name=value` or `--name value`); returns the next index, or -1 to refuse
  const option = (i: number, after: boolean): number => {
    const word = w[i];
    const eq = word.indexOf('=');
    const name = eq > 0 ? word.slice(0, eq) : word;
    if (!/^--[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || seen.has(name) || awsRefusedOption(name)) return -1;
    seen.add(name);
    const inline = eq > 0 ? word.slice(eq + 1) : undefined;
    const take = (): string | undefined => {
      if (inline !== undefined) return inline;
      const v = w[i + 1];
      return v === undefined || v.startsWith('-') ? undefined : v;
    };
    const global = AWS_GLOBAL_VALUES[name] ?? (after ? AWS_PAGING_VALUES[name] : undefined);
    if (global) {
      const v = take();
      if (v === undefined || !global.test(v)) return -1;
      values.set(name, v);
      return inline !== undefined ? i + 1 : i + 2;
    }
    if (AWS_GLOBAL_FLAGS.has(name)) return inline !== undefined ? -1 : i + 1;
    // Before the service only the global options above; after the operation its own options too
    if (!after || awsRefusedOption(name)) return -1;
    if (AWS_REFUSED_OPTION_WORDS.test(name) && !AWS_PAGINATION_TOKENS.has(name)) return -1;
    // --no-… is a flag: it takes no value, and a word after it is a positional (refused)
    if (name.startsWith('--no-')) return inline !== undefined ? -1 : i + 1;
    const v = take();
    if (v === undefined) return inline !== undefined ? -1 : i + 1; // a flag (--recursive, --include-all …)
    if (v.startsWith('-')) return -1;
    values.set(name, v);
    return inline !== undefined ? i + 1 : i + 2;
  };

  let i = 1;
  while (i < w.length && w[i].startsWith('-')) {
    i = option(i, false);
    if (i < 0) return false;
  }
  const service = w[i];
  const op = w[i + 1];
  if (!service || !op || !AWS_NAME.test(service) || !AWS_NAME.test(op)) return false;
  const name = `${service} ${op}`;
  const explicit = AWS_EXPLICIT_READS.has(name);
  if (!explicit) {
    if (!AWS_READ_SERVICES.has(service) || AWS_REFUSED_SERVICES.has(service) || AWS_REFUSED_OPS.has(name)) return false;
    if (!/^(get|list|describe)-/.test(op)) return false;
    if (AWS_SECRET_WORDS.some((x) => op.includes(x))) return false;
  }
  const positional: string[] = [];
  i += 2;
  while (i < w.length) {
    if (!w[i].startsWith('-')) {
      positional.push(w[i++]);
      continue;
    }
    if (name === 's3 ls' && AWS_S3_LS_FLAGS.has(w[i])) {
      if (seen.has(w[i])) return false;
      seen.add(w[i++]);
      continue;
    }
    i = option(i, true);
    if (i < 0) return false;
  }
  if (name === 's3 ls') {
    // only its flags, the paging and global options, and at most one s3:// location
    if ([...seen].some((o) => !AWS_S3_LS_FLAGS.has(o) && !(o in AWS_GLOBAL_VALUES) && !(o in AWS_PAGING_VALUES) && !AWS_GLOBAL_FLAGS.has(o))) return false;
    return positional.length <= 1 && positional.every((p) => AWS_S3_URI.test(p));
  }
  if (positional.length) return false;
  if (service === 'configure') return [...seen].every((o) => o === '--profile');
  if (name in AWS_LAMBDA_LISTS) return lambdaQueryKeepsFields(AWS_LAMBDA_LISTS[name], values.get('--query'));
  return true;
}

/**
 * True when every simple command in the line only reads (plan mode runs these without asking). False for any
 * substitution ($(…), backticks, <(…)), a redirection into a file, a leading VAR=value, a program outside the list,
 * a listed program with a flag that writes or runs something (sed -i, sort -o, git -c, rg --pre …), or an aws
 * command isAwsRead does not recognise. False as well for anything zsh could read differently from the lexers here
 * or expand into code or into other words (plainForShell), and for a wildcard that a file's name could turn into an
 * option or a second operand (namesStayNames). A line that starts with `cd <dir> &&` (leadingCd: one plain literal
 * folder, joined by && and | only) is judged by the rest, as if the shell had started in <dir>; the guard
 * (guardCommand) reads its paths at that folder, and asks "reads secrets" for a folder that is a secret path itself.
 * The whole line, the cd included, has to be plain for the shell first.
 */
export function isReadOnlyCommand(command: string): boolean {
  const raw = command.trim();
  if (!raw) return false;
  if (!plainForShell(raw)) return false;
  const cd = leadingCd(raw);
  return readOnlyLine(cd ? cd.rest : raw);
}

/**
 * isReadOnlyCommand for a tool call. A leading cd is seen through only for bash, whose shell this app starts itself:
 * not interactive, with no cd search path (shell.ts), and back in its own folder on the next call. In a terminal tab
 * (terminal_run) a cd moves the user's own shell, which may search cdpath or run hooks on it, so that line keeps its
 * check.
 */
export function isReadOnlyCall(name: string, command: string): boolean {
  if (name !== 'bash' && leadingCd(command)) return false;
  return isReadOnlyCommand(command);
}

/** isReadOnlyCommand for a line as it is, a leading cd included (cd is not a read-only program) */
function readOnlyLine(raw: string): boolean {
  if (!plainForShell(raw)) return false;
  if (substitutions(raw).found) return false;
  for (const simple of splitCommands(raw)) {
    const { argv, assigns, lexed } = argvOf(simple);
    if (assigns) return false;
    if (lexed.writes.some((t) => !NULL_DEVICES.has(t))) return false;
    const prog = path.basename(argv[0] ?? '');
    if (!prog) continue;
    if (prog === 'aws') {
      if (!isAwsRead(simple)) return false;
      continue;
    }
    if (!READ_ONLY_PROGRAMS.has(prog)) return false;
    if (!namesStayNames(prog, simple)) return false;
    if (!readOnlyArgs(prog, argv)) return false;
  }
  return true;
}

/**
 * False when zsh, which runs the command, could read the line differently from the lexers here, or turn a word into
 * code or into other words. Outside single quotes, and not after a backslash:
 *  - a control character other than a tab or a new line;
 *  - a backtick, and a $ that starts anything but $NAME, ${NAME} or a positional or special parameter: so $(…),
 *    $((…)) and $[…] (arithmetic evaluates subscripts, which may hold a substitution inside quotes), ${…} with a flag,
 *    a default, an assignment or another expansion in it, $~x $=x $^x $+x (a value read again as a pattern or as
 *    words), $x[…], and $'…' / $"…" (quoted by other rules than '…' and "…");
 * and, outside double quotes as well:
 *  - ( or ): a glob qualifier runs code (ls *(e:'cmd':)), as do subshells, functions and =(…) <(…) >(…);
 *  - { or }, except a literal {word} with no comma and no .. (HEAD@{1}): brace expansion makes words, so
 *    sort {-o,out} f is sort -o out f;
 *  - # at the start of a word: a comment, in which the lexers would read a quote and zsh would not;
 *  - << that is not <<<: a here-document's body is expanded whatever quotes it holds.
 * False too for an unclosed quote and a trailing backslash.
 */
export function plainForShell(s: string): boolean {
  let dq = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if ((code < 0x20 && c !== '\t' && c !== '\n') || code === 0x7f) return false;
    if (c === '\\') {
      if (i + 1 >= s.length) return false;
      i++;
      continue;
    }
    if (c === "'" && !dq) {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return false;
      i = end;
      continue;
    }
    if (c === '"') {
      dq = !dq;
      continue;
    }
    if (c === '`') return false;
    if (c === '$') {
      const rest = s.slice(i + 1);
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (name) {
        if (rest[name[0].length] === '[') return false;
        i += name[0].length;
        continue;
      }
      const braced = /^\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(rest);
      if (braced) {
        i += braced[0].length;
        continue;
      }
      if (/^[0-9?$#@*!-]/.test(rest)) {
        i++;
        continue;
      }
      // Arithmetic on numbers alone ($((1 + 2))): no name in it, so nothing is looked up or evaluated twice
      const sum = /^\(\([0-9\s+*/%()-]*\)\)/.exec(rest);
      if (sum) {
        i += sum[0].length;
        continue;
      }
      // What is left either starts an expansion this does not read, or is a $ that stands for itself ("a$|b")
      if (/^[([{'~=^+]/.test(rest) || (!dq && rest[0] === '"')) return false;
      continue;
    }
    if (dq) continue;
    if (c === '(' || c === ')' || c === '}') return false;
    if (c === '{') {
      const literal = /^\{[A-Za-z0-9_^~./-]*\}/.exec(s.slice(i));
      if (!literal || literal[0].includes('..')) return false;
      i += literal[0].length - 1;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;|&]/.test(s[i - 1]))) return false;
    if (c === '<' && s[i + 1] === '<') {
      if (s[i + 2] !== '<') return false;
      i += 2;
    }
  }
  return !dq;
}

/** Programs no file name can turn against the user: none of their options writes a file or runs a program */
const NAME_SAFE_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'stat', 'du', 'basename', 'dirname', 'realpath', 'readlink', 'md5', 'shasum', 'cmp', 'nl', 'column', 'cut', 'tr', 'grep', 'test', '[']);
/** Programs that read every word after `--` as a file or a pattern, never as an option */
const HONOURS_DASH_DASH = new Set(['sort', 'sed', 'rg', 'git', 'diff', 'awk']);

/**
 * The words of a simple command as written, each with what a wildcard in it could become: `glob` when it holds an
 * unquoted * ? or [, and `prefix`, the fixed text before the first one (quotes removed, $NAME left out since it may
 * be empty). zsh puts every matching file name in the word's place, so with an empty prefix, or one that starts with
 * -, a file named like an option becomes one (sort * with a file called -oout is sort -oout).
 */
function writtenWords(simple: string): { text: string; glob: boolean; prefix: string }[] {
  const out: { text: string; glob: boolean; prefix: string }[] = [];
  let i = 0;
  while (i < simple.length) {
    if (/\s/.test(simple[i])) {
      i++;
      continue;
    }
    const start = i;
    let glob = false;
    let prefix = '';
    let quote: string | null = null;
    for (; i < simple.length; i++) {
      const c = simple[i];
      if (quote === "'") {
        if (c === "'") quote = null;
        else if (!glob) prefix += c;
        continue;
      }
      if (c === '\\' && i + 1 < simple.length) {
        if (!glob) prefix += simple[i + 1];
        i++;
        continue;
      }
      if (c === '$') {
        const name = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(simple.slice(i));
        if (name) {
          i += name[0].length - 1;
          continue;
        }
      }
      if (quote === '"') {
        if (c === '"') quote = null;
        else if (!glob) prefix += c;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '*' || c === '?' || c === '[') glob = true;
      else if (!glob) prefix += c;
    }
    out.push({ text: simple.slice(start, i), glob, prefix });
  }
  return out;
}

/**
 * False when a wildcard could hand a read-only program something other than the file names it looks like it names:
 * a word whose wildcard has no fixed text before it, or only text that starts with - (sort *, sort -*, sort ?x),
 * for any program with an option that writes or runs something, unless the program reads every word after -- as a
 * name and the word comes after one; and any wildcard at all for uniq, whose second file name is the file it writes.
 */
function namesStayNames(prog: string, simple: string): boolean {
  if (NAME_SAFE_PROGRAMS.has(prog)) return true;
  let namesOnly = false;
  for (const w of writtenWords(simple)) {
    if (!w.glob) {
      if (w.text === '--' && HONOURS_DASH_DASH.has(prog)) namesOnly = true;
      continue;
    }
    if (prog === 'uniq') return false;
    // (--include=*.ts stays what it is: the option's name is fixed before the wildcard)
    if (!namesOnly && (w.prefix === '' || (w.prefix.startsWith('-') && !/^--[A-Za-z0-9-]+=/.test(w.prefix)))) return false;
  }
  return true;
}
