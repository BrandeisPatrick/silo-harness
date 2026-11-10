// Skills: folders holding a SKILL.md (YAML frontmatter, then Markdown instructions) and any supporting files.
// docs/skills.md defines the format; this file reads, checks and expands them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillInfo } from '../shared/types';
import { parseFrontmatter, type FmValue } from './frontmatter';
import { projectFolders } from './instructions';
import { configDir, configDirOverride } from './paths';

export interface Skill extends SkillInfo {
  /** The instructions after the frontmatter, trimmed */
  body: string;
  /** The skill's folder (for a command file: the folder it is in) */
  dir: string;
  argumentHint: string;
  /** False when `user-invocable: false`: hidden from the / menu */
  userInvocable: boolean;
  /** False when `disable-model-invocation: true` (and for .claude/commands files): not offered to the model */
  modelInvocable: boolean;
  problems: string[];
  /** 'command' for a .claude/commands/*.md file */
  kind: 'skill' | 'command';
}

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
/** The project folders that hold skills, in order: the app's own (and its names before the renames), then the cross-tool ones */
const PROJECT_DIRS = ['.silo-harness', '.open-harness', '.openagent', '.opencoder', '.agents', '.claude'];

export interface SkillOptions {
  /** The home folder for the user-level folders (tests pass a temp one) */
  home?: string;
}

// Kept from the last loadSkills call so the skill tool can re-scan on a miss
let lastAppRoot = '';
let lastOptions: SkillOptions = {};

/** Every folder skills are read from, in order (first wins by name). */
export function skillSources(cwd: string, appRoot: string, opts: SkillOptions = {}): { dir: string; source: Skill['source']; kind: Skill['kind'] }[] {
  const home = path.resolve(opts.home ?? os.homedir());
  const { dirs } = projectFolders(cwd, home);
  const nearest = [...dirs].reverse();
  const out: { dir: string; source: Skill['source']; kind: Skill['kind'] }[] = [];
  for (const d of nearest) for (const p of PROJECT_DIRS) out.push({ dir: path.join(d, p, 'skills'), source: 'project', kind: 'skill' });
  for (const d of nearest) out.push({ dir: path.join(d, '.claude', 'commands'), source: 'project', kind: 'command' });
  // A config-folder override (an isolated run, the tests) stands in for all the user-level folders
  const override = opts.home ? null : configDirOverride();
  const userDirs = override
    ? [override]
    : [configDir(home), ...['.silo-harness', '.open-harness', '.openagent', '.opencoder', '.agents', '.claude'].map((p) => path.join(home, p))];
  for (const d of [...new Set(userDirs)]) out.push({ dir: path.join(d, 'skills'), source: 'user', kind: 'skill' });
  if (!override) out.push({ dir: path.join(home, '.claude', 'commands'), source: 'user', kind: 'command' });
  if (appRoot) out.push({ dir: path.join(appRoot, 'skills'), source: 'bundled', kind: 'skill' });
  return out;
}

/**
 * Reads the skills for a session in `cwd`: the project's (from the session folder up to its git root, nearest first),
 * the user's, then the app's bundled ones. The first of a name wins (names compare case-insensitively).
 */
export function loadSkills(cwd: string, appRoot: string, opts: SkillOptions = {}): Skill[] {
  lastAppRoot = appRoot;
  lastOptions = opts;
  const byName = new Map<string, Skill>();
  const add = (s: Skill) => {
    const key = s.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, s);
  };
  for (const src of skillSources(cwd, appRoot, opts)) {
    if (src.kind === 'command') {
      for (const s of readCommands(src.dir, src.source)) add(s);
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(src.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const folder = path.join(src.dir, e.name);
      if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(folder))) continue;
      const file = path.join(folder, 'SKILL.md');
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      add(parseSkill(raw, e.name, file, src.source));
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const text = (v: FmValue | undefined): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** Reads one SKILL.md. Never throws; what is wrong goes into `problems`. */
export function parseSkill(raw: string, dirName: string, file: string, source: Skill['source']): Skill {
  const fm = parseFrontmatter(raw);
  const problems: string[] = [];
  const d = fm.data;
  if (!fm.present) problems.push('no frontmatter (a --- block at the top)');
  else if (fm.error) problems.push(`frontmatter could not be read (line ${fm.error.line})`);

  let name = dirName;
  if (d.name !== undefined && d.name !== null) {
    const n = text(d.name);
    if (n === null) problems.push('name must be text');
    else if (!NAME_RE.test(n)) problems.push(`name "${n}" must be lower-case letters, digits and hyphens`);
    else if (n.length > MAX_NAME) problems.push(`name is longer than ${MAX_NAME} characters`);
    else {
      name = n;
      if (n !== dirName) problems.push(`name does not match folder "${dirName}"`);
    }
  }
  if (name === dirName && !NAME_RE.test(dirName)) problems.push(`folder name "${dirName}" must be lower-case letters, digits and hyphens`);

  let description = '';
  if (d.description === undefined || d.description === null || d.description === '') {
    if (fm.present) problems.push('no description');
  } else {
    const t = text(d.description);
    if (t === null) problems.push('description must be text');
    else {
      description = t.trim();
      if (!description) problems.push('no description');
      if (description.length > MAX_DESCRIPTION) problems.push('description is longer than 1,024 characters');
    }
  }
  const common = readCommon(d, problems);
  const body = fm.body.trim();
  if (!body) problems.push('no instructions after the frontmatter');
  const dir = path.dirname(file);
  return { name, description, path: file, dir, source, body, ...common, problems, kind: 'skill' };
}

function readCommon(d: Record<string, FmValue>, problems: string[]): Pick<Skill, 'argumentHint' | 'userInvocable' | 'modelInvocable'> {
  let argumentHint = '';
  if (d['argument-hint'] !== undefined && d['argument-hint'] !== null) {
    const v = d['argument-hint'];
    // An unquoted [hint] reads as a list; take it back as written
    const t = Array.isArray(v) ? `[${v.join(', ')}]` : text(v);
    if (t === null) problems.push('argument-hint must be text');
    else argumentHint = t.trim();
  }
  const bool = (key: string, fallback: boolean): boolean => {
    const v = d[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v === 'boolean') return v;
    problems.push(`${key} must be true or false`);
    return fallback;
  };
  return { argumentHint, userInvocable: bool('user-invocable', true), modelInvocable: !bool('disable-model-invocation', false) };
}

/** .claude/commands/**\/*.md: body-only commands the user runs with /name (nested folders give /folder:name). */
function readCommands(root: string, source: Skill['source']): Skill[] {
  const out: Skill[] = [];
  const walk = (dir: string, prefix: string[], depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, [...prefix, e.name], depth + 1);
      } else if (e.name.toLowerCase().endsWith('.md')) {
        let raw: string;
        try {
          raw = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        out.push(parseCommand(raw, [...prefix, e.name.slice(0, -3)], p, source));
      }
    }
  };
  walk(root, [], 0);
  return out;
}

export function parseCommand(raw: string, parts: string[], file: string, source: Skill['source']): Skill {
  const fm = parseFrontmatter(raw);
  const problems: string[] = [];
  if (fm.error) problems.push(`frontmatter could not be read (line ${fm.error.line})`);
  const name = parts.join(':');
  for (const p of parts) if (!NAME_RE.test(p)) problems.push(`name "${p}" must be lower-case letters, digits and hyphens`);
  const body = fm.body.trim();
  if (!body) problems.push('no instructions');
  let description = (text(fm.data.description) ?? '').trim();
  if (!description) description = (body.split('\n').find((l) => l.trim()) ?? '').replace(/^#+\s*/, '').trim().slice(0, 100);
  const common = readCommon(fm.data, problems);
  return { name, description, path: file, dir: path.dirname(file), source, body, ...common, modelInvocable: false, problems, kind: 'command' };
}

/** Finds a skill by name, case-insensitively, with or without the leading "/". */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const key = name.trim().replace(/^\//, '').toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === key);
}

/**
 * Re-reads the project and user folders (as the last loadSkills call did) and returns the skill of that name, for a
 * skill written during the session.
 */
export function rescanSkill(cwd: string, name: string): Skill | undefined {
  return findSkill(loadSkills(cwd, lastAppRoot, lastOptions), name);
}

/** ${SKILL_DIR} and Claude Code's ${CLAUDE_SKILL_DIR} become the skill's folder. */
export function withSkillDir(body: string, dir: string): string {
  return body.replace(/\$\{(?:CLAUDE_)?SKILL_DIR\}/g, dir);
}

/** Splits typed arguments like a shell: spaces separate, quotes group. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const PLACEHOLDER_RE = /\$ARGUMENTS\b|\$[1-9]/;

/** Substitutes $ARGUMENTS, $ARGUMENTS[n] (from 0) and $1…$9 (from 1); without any, appends "ARGUMENTS: …". */
export function substituteArguments(body: string, args: string): string {
  const list = splitArguments(args);
  if (!PLACEHOLDER_RE.test(body)) return args ? `${body}\n\nARGUMENTS: ${args}` : body;
  return body
    .replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, n: string) => list[Number(n)] ?? '')
    .replace(/\$ARGUMENTS\b/g, args)
    .replace(/\$([1-9])(?!\d)/g, (_m, n: string) => list[Number(n) - 1] ?? '');
}

export const SLASH_RE = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/;

/** Turns "/name args" into the message the model sees: the user's line plus the skill body, arguments filled in. */
export function expandSlashCommand(text: string, skills: Skill[]): { content: string; skill?: Skill } {
  const m = SLASH_RE.exec(text.trim());
  if (!m) return { content: text };
  const skill = findSkill(skills, m[1]);
  if (!skill || !skill.userInvocable || !skill.body) return { content: text };
  const body = substituteArguments(withSkillDir(skill.body, skill.dir), (m[2] ?? '').trim());
  return { content: `${text.trim()}\n\n<skill name="${skill.name}">\n${body}\n</skill>`, skill };
}

/** About 2% of a context window of `contextTokens`, in characters (4 per token) */
export function skillListBudget(contextTokens: number): number {
  return Math.max(1000, Math.round(contextTokens * 0.02 * 4));
}

/** The default budget: 2% of a 200k-token window */
export const DEFAULT_SKILL_LIST_CHARS = skillListBudget(200_000);

/**
 * The skill list for the system prompt ('' when none is offered): one `name: description` line per skill inside
 * <available_skills>, leaving out skills the model may not load or that have no description. Each description is cut
 * at 1,024 characters, and the longest are cut further until the list fits `budget` characters; names are never dropped.
 */
export function skillsPrompt(skills: Skill[], budget: number = DEFAULT_SKILL_LIST_CHARS): string {
  const offered = skills.filter((s) => s.modelInvocable && s.description && s.body);
  if (!offered.length) return '';
  const head = '\n\nAvailable skills (load one with the skill tool when the task matches its description):\n<available_skills>\n';
  const foot = '\n</available_skills>';
  const descs = offered.map((s) => s.description.replace(/\s+/g, ' ').trim());
  const size = (cap: number) => offered.reduce((n, s, i) => n + s.name.length + (descs[i].length > cap ? cap + 3 : descs[i].length + 2) + 1, 0);
  let cap = MAX_DESCRIPTION;
  const room = budget - head.length - foot.length;
  if (size(cap) > room) {
    let lo = 0;
    let hi = cap;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(mid) <= room) lo = mid;
      else hi = mid - 1;
    }
    cap = lo;
  }
  cap = Math.min(cap, MAX_DESCRIPTION);
  const lines = offered.map((s, i) => {
    const dsc = descs[i];
    if (cap === 0 && dsc.length) return s.name;
    return `${s.name}: ${dsc.length > cap ? `${dsc.slice(0, cap).trimEnd()}…` : dsc}`;
  });
  return `${head}${lines.join('\n')}${foot}`;
}

/** The files beside SKILL.md, as paths relative to the skill's folder (at most `max`), and how many there are */
export function supportingFiles(skill: Skill, max = 20): { files: string[]; total: number } {
  if (skill.kind !== 'skill') return { files: [], total: 0 };
  const files: string[] = [];
  let total = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 4) walk(path.join(dir, e.name), r, depth + 1);
      } else if (r !== 'SKILL.md') {
        total++;
        if (files.length < max) files.push(r);
      }
    }
  };
  walk(skill.dir, '', 0);
  return { files, total };
}

export function toInfo(s: Skill): SkillInfo {
  return { name: s.name, description: s.description, path: s.path, source: s.source, dir: s.dir, argumentHint: s.argumentHint, userInvocable: s.userInvocable, problems: s.problems };
}
