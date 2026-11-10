// Project instructions: the Markdown files the system prompt includes on every run. A user-level file in
// ~/.silo-harness, then the project's files from the git root down to the session folder: AGENTS.md (the cross-tool
// name), CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md (Claude Code's names) and SILOHARNESS.md, with `@path` imports.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSecretPath } from './guard';
import { configDir, tildeLabel } from './paths';

/**
 * The app's own names for the project file, new first (the app was Open Harness, OpenAgent, and OpenCoder before
 * that), then the cross-tool ones. The composer's "#" and Dreaming write to the first that exists in the session folder.
 */
export const INSTRUCTION_FILES = ['SILOHARNESS.md', 'OPENHARNESS.md', 'OPENAGENT.md', 'OPENCODER.md', 'AGENTS.md', 'CLAUDE.md'];
/** The app's own names: one file under successive names, so only the first that exists in a folder is read */
const OWN_NAMES = ['SILOHARNESS.md', 'OPENHARNESS.md', 'OPENAGENT.md', 'OPENCODER.md'];
/** Read in every folder, each one that exists, before the app's own file */
const SHARED_NAMES = ['AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md'];
/** The user-level file's names in the config folder, new first (OPENHARNESS.md is its name from before the rename) */
export const USER_INSTRUCTION_NAMES = ['SILOHARNESS.md', 'OPENHARNESS.md'];

/** All instruction text together stays under this many characters; the outermost files are cut first. */
export const INSTRUCTIONS_BUDGET = 32 * 1024;
const MAX_IMPORT_DEPTH = 4;

/**
 * The user-level instructions file: <config>/SILOHARNESS.md, or <config>/OPENHARNESS.md when only that one is there.
 * Read on every call, so it follows the config folder (and a test's override).
 */
export function userInstructionsFile(dir: string = configDir()): { path: string; label: string } {
  const name = USER_INSTRUCTION_NAMES.find((n) => isFile(path.join(dir, n))) ?? USER_INSTRUCTION_NAMES[0];
  const file = path.join(dir, name);
  return { path: file, label: tildeLabel(file) };
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The git root above `cwd` (the nearest folder holding .git), or null. The walk never reaches the home folder
 * itself or anything above it, so it only looks at folders between the session folder and its repository.
 */
export function gitRoot(cwd: string, home: string = os.homedir()): string | null {
  let dir = path.resolve(cwd);
  const h = path.resolve(home);
  // Below home: stop before home (a dotfiles repo there is not this project). At home itself: home only.
  const underHome = inside(dir, h) && dir !== h;
  if (dir === h) return fs.existsSync(path.join(dir, '.git')) ? dir : null;
  for (;;) {
    if (underHome && dir === h) return null;
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** The folders to read, outermost first: the git root down to the session folder, or the session folder alone. */
export function projectFolders(cwd: string, home: string = os.homedir()): { root: string; dirs: string[] } {
  const start = path.resolve(cwd);
  const root = gitRoot(start, home);
  if (!root) return { root: start, dirs: [start] };
  const dirs: string[] = [];
  for (let d = start; ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (d === root || path.dirname(d) === d) break;
  }
  return { root, dirs };
}

export interface InstructionFile {
  /** Absolute path */
  path: string;
  /** How the prompt names it: its path from the project root ("AGENTS.md", "packages/web/CLAUDE.md"), or "~/.silo-harness/SILOHARNESS.md" */
  label: string;
  text: string;
  truncated: boolean;
}

export interface InstructionOptions {
  /** The home folder (tests pass a temp one) */
  home?: string;
  /** The user-level config folder; configDir() by default */
  configDir?: string;
  /** The character budget for everything; INSTRUCTIONS_BUDGET by default */
  budget?: number;
}

const SECRET_RE = /^(\.env.*|id_rsa.*|.*\.pem|.*\.key)$/i;
/** Other tools' rule files, the only dotfiles an import may name */
const RULE_DOTFILES = ['.cursorrules', '.windsurfrules', '.clinerules', '.goosehints'];

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function readText(file: string): string | null {
  try {
    if (!fs.statSync(file).isFile()) return null;
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  } catch {
    return null;
  }
}

interface ImportCtx {
  home: string;
  /** Folders an import may come from */
  roots: string[];
  /** Real paths already in the prompt: importing one again is left as text */
  seen: Set<string>;
}

/** Replaces `@path` imports (outside code) with the file they name, recursively. Anything refused stays as written. */
function expandImports(text: string, file: string, ctx: ImportCtx, stack: string[]): string {
  if (stack.length > MAX_IMPORT_DEPTH) return text;
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const f = /^\s*(```+|~~~+)/.exec(line);
      if (f) {
        if (!fence) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
        return line;
      }
      if (fence || !line.includes('@')) return line;
      // Odd segments between backticks are inline code
      return line
        .split('`')
        .map((seg, k) => (k % 2 ? seg : seg.replace(/(^|\s)@([^\s`]+)/g, (whole, pre: string, ref: string) => {
          const clean = ref.replace(/[.,;:!?)\]]+$/, '');
          const tail = ref.slice(clean.length);
          const got = importFile(clean, file, ctx, stack);
          return got === null ? whole : `${pre}${got}${tail}`;
        })))
        .join('`');
    })
    .join('\n');
}

function importFile(ref: string, from: string, ctx: ImportCtx, stack: string[]): string | null {
  if (!ref || /^[a-z][\w+.-]*:/i.test(ref)) return null;
  const abs = ref.startsWith('~/') ? path.join(ctx.home, ref.slice(2)) : path.resolve(path.dirname(from), ref);
  const base = path.basename(abs);
  const ext = path.extname(base).toLowerCase();
  if (ext && !['.md', '.markdown', '.txt'].includes(ext)) return null;
  if (SECRET_RE.test(base)) return null;
  // No dotfile without an extension (.npmrc, .netrc), nothing under .git, nothing the guard counts as a secret
  if (base.startsWith('.') && !RULE_DOTFILES.includes(base)) return null;
  if (abs.split(path.sep).includes('.git') || isSecretPath(abs)) return null;
  if (!ctx.roots.some((r) => inside(abs, r))) return null;
  const real = realpath(abs);
  if (!ctx.roots.some((r) => inside(real, realpath(r)))) return null;
  if (stack.includes(real) || ctx.seen.has(real)) return null;
  if (stack.length >= MAX_IMPORT_DEPTH + 1) return null;
  const text = readText(abs);
  if (text === null) return null;
  ctx.seen.add(real);
  return expandImports(text.trim(), abs, ctx, [...stack, real]);
}

/**
 * The instruction files for a session in `cwd`: the user-level file first, then the project's from the outermost
 * folder to the session folder (the nearest has the last word). Duplicates (a symlink, a copy, a file already
 * imported) are read once. Everything shares one budget; when it is over, the outermost files are cut first.
 */
export function loadInstructions(cwd: string, opts: InstructionOptions = {}): InstructionFile[] {
  const home = opts.home ?? os.homedir();
  const conf = opts.configDir ?? configDir();
  const budget = opts.budget ?? INSTRUCTIONS_BUDGET;
  const { root, dirs } = projectFolders(cwd, home);
  const userRoots = [conf, ...['.silo-harness', '.open-harness', '.claude', '.agents'].map((d) => path.join(home, d))];
  const ctx: ImportCtx = { home, roots: [root, ...userRoots], seen: new Set() };
  const seenText = new Set<string>();

  const take = (file: string, label: string): InstructionFile | null => {
    const real = realpath(file);
    if (ctx.seen.has(real)) return null;
    const raw = readText(file);
    if (raw === null) return null;
    ctx.seen.add(real);
    const text = expandImports(raw.trim(), file, ctx, [real]).trim();
    if (!text || seenText.has(text)) return null;
    seenText.add(text);
    return { path: file, label, text, truncated: false };
  };

  // The user-level file, then the ones from before the renames
  let user: InstructionFile | null = null;
  const u = userInstructionsFile(conf);
  for (const [file, label] of [
    [u.path, u.label],
    [path.join(home, '.openagent', 'OPENAGENT.md'), '~/.openagent/OPENAGENT.md'],
    [path.join(home, '.opencoder', 'OPENCODER.md'), '~/.opencoder/OPENCODER.md'],
  ] as const) {
    user ??= take(file, label);
  }

  const project: InstructionFile[] = [];
  for (const dir of dirs) {
    const names = [...SHARED_NAMES];
    const own = OWN_NAMES.find((n) => isFile(path.join(dir, n)));
    if (own) names.push(own);
    for (const name of names) {
      const file = path.join(dir, name);
      const hit = take(file, path.relative(root, file) || name);
      if (hit) project.push(hit);
    }
  }
  fitBudget(project, user, budget);
  return [...(user ? [user] : []), ...project.filter((f) => f.text)];
}

/** Cuts the outermost project files first, then the user file, until the total fits; notes it in the text. */
function fitBudget(project: InstructionFile[], user: InstructionFile | null, budget: number): void {
  const all = [...project, ...(user ? [user] : [])];
  let over = all.reduce((n, f) => n + f.text.length, 0) - budget;
  if (over <= 0) return;
  const note = `\n[… cut to fit the ${Math.round(budget / 1024)} KiB instructions budget]`;
  const dropped: string[] = [];
  for (const f of all) {
    if (over <= 0) break;
    const keep = f.text.length - over - note.length;
    if (keep < 200) {
      over -= f.text.length;
      f.text = '';
      f.truncated = true;
      dropped.push(f.label);
    } else {
      f.text = f.text.slice(0, keep) + note;
      f.truncated = true;
      over = 0;
    }
  }
  const first = all.find((f) => f.text);
  if (dropped.length && first) first.text = `[Left out to fit the ${Math.round(budget / 1024)} KiB instructions budget: ${dropped.join(', ')}]\n${first.text}`;
  if (user && !user.text) user.text = '';
}

/**
 * Appends one bullet to the project's instructions file (the first existing of INSTRUCTION_FILES; SILOHARNESS.md is
 * created when none exists), for the composer's "#" shortcut. Returns the file and its label.
 */
export function appendInstruction(cwd: string, text: string): { path: string; label: string } {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) throw new Error('Nothing to add.');
  let label = INSTRUCTION_FILES.find((name) => isFile(path.join(cwd, name)));
  const file = path.join(cwd, label ?? INSTRUCTION_FILES[0]);
  let current = '';
  if (label) current = fs.readFileSync(file, 'utf8');
  else {
    label = INSTRUCTION_FILES[0];
    current = '# Project instructions\n\nNotes for the agent working in this project.\n';
  }
  const sep = current.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${current}${sep}- ${line}\n`);
  return { path: file, label };
}

/** The system-prompt section for the files, or '' when there is none. */
export function instructionsPrompt(files: InstructionFile[]): string {
  if (!files.length) return '';
  return files.map((f) => `\n\nInstructions from ${f.label} (follow them for this ${f.label.startsWith('~') ? 'user' : 'project'}):\n${f.text}`).join('');
}
