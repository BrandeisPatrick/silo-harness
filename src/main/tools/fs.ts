import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { isHomeScanRoot, isSecretPath } from '../guard';
import type { Tool, ToolContext } from './types';
import { truncate } from './types';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target']);

export function resolvePath(cwd: string, p: string): string {
  const expanded = p.replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(cwd, expanded);
}

/**
 * A read of a secret path (keys, credentials, .env, the app's own data), or a walk (`walks`: grep, glob) rooted at the
 * home folder, ~/Library, /, /Users or /Volumes, asks first: the rules decide (Bypass runs it, Auto mode's check or a
 * card with "reads secrets" or "scans the home folder" otherwise). Null when it may go on, else the message for the model.
 */
async function approveRead(ctx: ToolContext, name: string, target: string, walks = false): Promise<string | null> {
  if (!isSecretPath(target, ctx.cwd) && !(walks && isHomeScanRoot(target, ctx.cwd))) return null;
  const approval = await ctx.approve(name, target, target);
  return approval.ok ? null : approval.message;
}

/** What a session saw of a file when read_file last returned it, or the agent last wrote it: its mtime and size */
interface Seen {
  mtimeMs: number;
  size: number;
}
const MAX_SESSIONS = 50;
const MAX_FILES = 500;
/** Per session, the files it read (oldest first; both maps capped) */
const seen = new Map<string, Map<string, Seen>>();

async function stat(file: string): Promise<Seen | null> {
  return fs.stat(file).then((s) => ({ mtimeMs: s.mtimeMs, size: s.size }), () => null);
}

/** Records what a session saw of a file (read_file, and the agent's own writes and edits). */
async function remember(sessionId: string, file: string): Promise<void> {
  const st = await stat(file);
  if (!st) return;
  let files = seen.get(sessionId);
  if (files) seen.delete(sessionId);
  else files = new Map();
  seen.set(sessionId, files);
  if (seen.size > MAX_SESSIONS) seen.delete(seen.keys().next().value as string);
  files.delete(file);
  files.set(file, st);
  if (files.size > MAX_FILES) files.delete(files.keys().next().value as string);
}

/** The error when the file changed on disk since the session read it; null when it did not, or was never read. */
async function staleError(sessionId: string, file: string): Promise<string | null> {
  const was = seen.get(sessionId)?.get(file);
  if (!was) return null;
  const now = await stat(file);
  if (now && now.mtimeMs === was.mtimeMs && now.size === was.size) return null;
  return `${file} changed on disk since you read it; read it again before editing.`;
}

export const readFile: Tool = {
  name: 'read_file',
  description: 'Read a text file and return its contents with line numbers. Use offset/limit to page through large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      offset: { type: 'integer', description: '1-based line number to start at (default 1)' },
      limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000)' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx.cwd, String(args.path));
    const refused = await approveRead(ctx, 'read_file', file);
    if (refused) return { content: refused };
    const data = await fs.readFile(file, 'utf8');
    await remember(ctx.sessionId, file);
    const lines = data.split('\n');
    const start = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 2000);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const width = String(start + slice.length).length;
    let out = slice.map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join('\n');
    if (start - 1 + limit < lines.length) out += `\n…(${lines.length} lines total; continue with offset=${start + limit})`;
    return { content: truncate(out) };
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent directories are created as needed.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx.cwd, String(args.path));
    const content = String(args.content ?? '');
    const approval = await ctx.approve('write_file', `${file}\n(${content.length} characters)`, file);
    if (!approval.ok) return { content: approval.message };
    ctx.beforeChange(file);
    const existed = await fs.stat(file).then(() => true, () => false);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, 'utf8');
    await remember(ctx.sessionId, file);
    // "Created" or "Wrote": the window's summary of a run of calls says which
    return { content: existed ? `Wrote ${Buffer.byteLength(content)} bytes to ${file}` : `Created ${file} (${Buffer.byteLength(content)} bytes)` };
  },
};

export const editFile: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file with a new string. old_string must match exactly once unless replace_all is true. Read the file first so the match is exact.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory' },
      old_string: { type: 'string', description: 'Exact text to find' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      edits: {
        type: 'array',
        description: 'Several replacements instead of one, applied in order, all or nothing',
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx.cwd, String(args.path));
    const { edits, multi } = editList(args);
    const stale = await staleError(ctx.sessionId, file);
    if (stale) throw new Error(stale);
    const before = await stat(file);
    const data = await fs.readFile(file, 'utf8');
    // Every replacement is found and made in memory first: one that does not match writes nothing
    let updated = data;
    const done: Applied[] = [];
    for (const [i, e] of edits.entries()) {
      try {
        const r = applyEdit(updated, e, file);
        updated = r.text;
        done.push(r);
      } catch (err) {
        if (!multi) throw err;
        throw new Error(`edits[${i}]: ${(err as Error).message} Nothing was written: none of the ${edits.length} edits was made.`);
      }
    }
    // The card shows every change: one replacement as it is; several as the lines of the file they span, before and after
    const shown = multi ? changedLines(data, updated) : { old: done[0].target, new: edits[0].newStr };
    const max = multi ? 20_000 : 800;
    const preview = `${file}\n--- old\n${truncate(shown.old, max)}\n+++ new\n${truncate(shown.new, max)}`;
    const approval = await ctx.approve('edit_file', preview, file);
    if (!approval.ok) return { content: approval.message };
    // The file changed while the card waited
    const after = await stat(file);
    if (!after || !before || after.mtimeMs !== before.mtimeMs || after.size !== before.size) throw new Error(`${file} changed on disk since you read it; read it again before editing.`);
    ctx.beforeChange(file);
    await fs.writeFile(file, updated, 'utf8');
    await remember(ctx.sessionId, file);
    const count = done.reduce((n, r) => n + r.count, 0);
    const notes = done.map((r, i) => (r.note ? `; ${multi ? `edits[${i}] ` : ''}${r.note}` : '')).join('');
    return { content: `Edited ${file} (${multi ? `${edits.length} edits, ` : ''}${count} replacement${count === 1 ? '' : 's'}${notes})` };
  },
};

/** One replacement of an edit_file call */
interface OneEdit {
  oldStr: string;
  newStr: string;
  all: boolean;
}

/** A replacement made in memory: the text after it, how many places, the exact text it replaced, and a note on a loose match */
interface Applied {
  text: string;
  count: number;
  target: string;
  note: string;
}

/** The replacements an edit_file call asks for: old_string and new_string, or the edits list (also as a JSON string). */
function editList(args: Record<string, unknown>): { edits: OneEdit[]; multi: boolean } {
  let list = args.edits;
  if (list === undefined || list === null) {
    const oldStr = String(args.old_string ?? '');
    if (!oldStr) throw new Error('old_string must not be empty');
    return { multi: false, edits: [{ oldStr, newStr: String(args.new_string ?? ''), all: !!args.replace_all }] };
  }
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      /* said below */
    }
  }
  if (args.old_string !== undefined || args.new_string !== undefined) throw new Error('Give old_string and new_string, or edits, not both.');
  if (!Array.isArray(list) || !list.length) throw new Error('edits must be a non-empty list of { old_string, new_string, replace_all? }.');
  const edits = list.map((e, i): OneEdit => {
    const o = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
    const oldStr = typeof o.old_string === 'string' ? o.old_string : '';
    if (!oldStr) throw new Error(`edits[${i}]: old_string must not be empty`);
    return { oldStr, newStr: typeof o.new_string === 'string' ? o.new_string : String(o.new_string ?? ''), all: !!o.replace_all };
  });
  return { multi: true, edits };
}

/** One replacement in `data`, or an error that says why it cannot be made (not found, ambiguous, several places). */
function applyEdit(data: string, e: OneEdit, file: string): Applied {
  let target = e.oldStr;
  let count = data.split(target).length - 1;
  let note = '';
  if (count === 0) {
    // Models often reproduce the text with slightly different whitespace. Fall back to a match that only treats
    // runs of whitespace (and quote and dash styles) as equal and, if it is unique, edit that exact span instead.
    const match = fuzzyMatch(data, e.oldStr);
    if (match === null) {
      const near = closestLines(data, e.oldStr);
      throw new Error(`old_string was not found in ${file}, even ignoring whitespace differences.${near ? `\nThe closest lines in the file:\n${near}\n` : ' '}Read the file and copy the text exactly.`);
    }
    if (match === 'ambiguous') throw new Error('old_string matches several places (ignoring whitespace); include more surrounding lines to make it unique.');
    target = match.text;
    count = data.split(target).length - 1;
    note = `matched ignoring ${match.how} at ${match.startLine === match.endLine ? `line ${match.startLine}` : `lines ${match.startLine}–${match.endLine}`}`;
  }
  if (count > 1 && !e.all) throw new Error(`old_string occurs ${count} times; make it unique or set replace_all=true`);
  const text = e.all ? data.split(target).join(e.newStr) : data.replace(target, () => e.newStr);
  return { text, count, target, note };
}

/** The whole lines of `before` that differ from `after`, and what they became: the span from the first change to the last. */
export function changedLines(before: string, after: string): { old: string; new: string } {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (suf < before.length - pre && suf < after.length - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) suf++;
  const start = pre === 0 ? 0 : before.lastIndexOf('\n', pre - 1) + 1;
  const endOf = (t: string) => {
    const nl = t.indexOf('\n', t.length - suf);
    return nl < 0 ? t.length : nl;
  };
  return { old: before.slice(start, endOf(before)), new: after.slice(start, endOf(after)) };
}

/** Curly quotes, long dashes and no-break spaces folded to ASCII, one character for one so offsets stay put */
function foldPunctuation(t: string): string {
  return t.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐-―−]/g, '-').replace(/[   ]/g, ' ');
}

/** [start, end) offsets of the unique match, null, or 'ambiguous'. */
type Span = { start: number; end: number } | null | 'ambiguous';

/** Lines compared with leading and trailing whitespace stripped. */
function matchTrimmedLines(haystack: string, needle: string): Span {
  const want = needle.split('\n').map((l) => l.trim());
  while (want.length && !want[want.length - 1]) want.pop();
  while (want.length && !want[0]) want.shift();
  if (!want.length) return null;
  const lines = haystack.split('\n');
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  const hits: { start: number; end: number }[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push({ start: offsets[i], end: offsets[i + want.length - 1] + lines[i + want.length - 1].length });
  }
  if (!hits.length) return null;
  if (hits.length > 1 && new Set(hits.map((h) => haystack.slice(h.start, h.end))).size > 1) return 'ambiguous';
  return hits[0];
}

/**
 * The text's whitespace-separated tokens compared in order: a run of whitespace (a newline included) equals any other
 * run, but never matches where the other text has none. The first token may end a longer one and the last may start one.
 */
function matchTokens(haystack: string, needle: string): Span {
  const want = needle.split(/\s+/).filter(Boolean);
  if (want.length < 2) return null;
  const toks: { t: string; start: number }[] = [];
  for (const m of haystack.matchAll(/\S+/g)) toks.push({ t: m[0], start: m.index ?? 0 });
  const hits: { start: number; end: number }[] = [];
  const last = want.length - 1;
  for (let i = 0; i + want.length <= toks.length; i++) {
    if (!toks[i].t.endsWith(want[0]) || !toks[i + last].t.startsWith(want[last])) continue;
    let ok = true;
    for (let j = 1; j < last; j++) {
      if (toks[i + j].t !== want[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const start = toks[i].start + toks[i].t.length - want[0].length;
    hits.push({ start, end: toks[i + last].start + want[last].length });
    if (hits.length > 1) return 'ambiguous';
  }
  return hits[0] ?? null;
}

/**
 * Finds `needle` in `haystack` when only whitespace (or quote and dash style) differs: lines with their ends trimmed,
 * then runs of whitespace treated as one, then both again with curly quotes and long dashes folded to ASCII. Never
 * matches where one text has whitespace between two tokens and the other has none. Returns the exact original text
 * of the unique match with its lines, null if none, or 'ambiguous'.
 */
export function fuzzyMatch(haystack: string, needle: string): { text: string; startLine: number; endLine: number; how: string } | null | 'ambiguous' {
  const tries: [string, string, string][] = [[haystack, needle, 'whitespace']];
  const fh = foldPunctuation(haystack);
  const fn = foldPunctuation(needle);
  if (fh !== haystack || fn !== needle) tries.push([fh, fn, 'whitespace and quote style']);
  for (const [h, n, how] of tries) {
    for (const find of [matchTrimmedLines, matchTokens]) {
      const span = find(h, n);
      if (span === 'ambiguous') return span;
      if (!span) continue;
      const text = haystack.slice(span.start, span.end);
      const startLine = haystack.slice(0, span.start).split('\n').length;
      return { text, startLine, endLine: startLine + (text.match(/\n/g)?.length ?? 0), how };
    }
  }
  return null;
}

/** The exact original text of the unique whitespace-tolerant match (see fuzzyMatch), null if none, or 'ambiguous'. */
export function fuzzyFind(haystack: string, needle: string): string | null | 'ambiguous' {
  const m = fuzzyMatch(haystack, needle);
  return m === null || m === 'ambiguous' ? m : m.text;
}

/** Character-bigram similarity of two lines (Dice), 0 to 1 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) grams.set(a.slice(i, i + 2), (grams.get(a.slice(i, i + 2)) ?? 0) + 1);
  let both = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      both++;
      grams.set(g, n - 1);
    }
  }
  return (2 * both) / (a.length + b.length - 2);
}

/** Up to 8 lines of the file from the one most like old_string's first non-empty line, numbered; '' when none is close. */
function closestLines(data: string, oldStr: string): string {
  const first = oldStr.split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return '';
  const lines = data.split('\n');
  let best = -1;
  let score = 0.4;
  lines.forEach((l, i) => {
    const s = similarity(l.trim(), first);
    if (s > score) {
      score = s;
      best = i;
    }
  });
  if (best < 0) return '';
  const shown = lines.slice(best, best + 8);
  const width = String(best + shown.length).length;
  return shown.map((l, i) => `${String(best + 1 + i).padStart(width)}| ${l}`).join('\n');
}

export const listDirectory: Tool = {
  name: 'list_directory',
  description: 'List the entries of a directory. Directories end with a slash.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path (default: working directory)' } },
  },
  async run(args, ctx) {
    const dir = resolvePath(ctx.cwd, String(args.path ?? '.'));
    const refused = await approveRead(ctx, 'list_directory', dir);
    if (refused) return { content: refused };
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    const shown = names.slice(0, 500);
    let out = `${dir}\n` + shown.join('\n');
    if (names.length > shown.length) out += `\n…(${names.length - shown.length} more entries)`;
    return { content: out };
  },
};

/** Characters of one grep line the model gets: a line of a minified file can be the whole file. */
export const GREP_LINE_CHARS = 400;
/** Matching lines grep returns at most */
export const GREP_MAX_LINES = 300;
/** Characters of a grep or glob result: one wide search otherwise rides along in every later request of the session. */
export const SEARCH_RESULT_CHARS = 12_000;

/** The first lines that fit in `max` characters (at least one), joined, and how many that is. */
function fitLines(lines: string[], max: number): { text: string; kept: number } {
  let size = 0;
  let kept = 0;
  for (const l of lines) {
    const next = size + (kept ? 1 : 0) + l.length;
    if (kept && next > max) break;
    size = next;
    kept++;
  }
  return { text: lines.slice(0, kept).join('\n'), kept };
}

function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const alts = pattern.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end;
      } else re += '\\{';
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else re += c;
  }
  return new RegExp(`^${re}$`);
}

export const glob: Tool = {
  name: 'glob',
  description: 'Find files matching a glob pattern (e.g. "src/**/*.ts", "**/*.test.js"). Ignores node_modules, .git and build output.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to the search root' },
      path: { type: 'string', description: 'Directory to search in (default: working directory)' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const root = resolvePath(ctx.cwd, String(args.path ?? '.'));
    const refused = await approveRead(ctx, 'glob', root, true);
    if (refused) return { content: refused };
    // Inside a search root that is not secret itself, secret files are left out (not asked about)
    const skipSecrets = !isSecretPath(root, ctx.cwd);
    const re = globToRegExp(String(args.pattern));
    const results: string[] = [];
    const MAX = 1000;
    async function walk(dir: string, rel: string): Promise<void> {
      if (results.length >= MAX) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= MAX) return;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (skipSecrets && isSecretPath(path.join(dir, e.name))) continue;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          await walk(path.join(dir, e.name), relPath);
        } else if (re.test(relPath)) {
          results.push(relPath);
        }
      }
    }
    await walk(root, '');
    if (!results.length) return { content: `No files matched ${args.pattern} under ${root}` };
    // Newest-modified first
    const times = new Map<string, number>();
    await Promise.all(results.map(async (r) => times.set(r, (await stat(path.join(root, r)))?.mtimeMs ?? 0)));
    results.sort((a, b) => (times.get(b) ?? 0) - (times.get(a) ?? 0) || a.localeCompare(b));
    const { text, kept } = fitLines(results, SEARCH_RESULT_CHARS);
    let out = text;
    const stopped = results.length >= MAX;
    if (kept < results.length) out += `\n…(${results.length - kept} more files${stopped ? ` found before the search stopped at ${MAX}` : ''}; narrow the pattern or path)`;
    else if (stopped) out += `\n…(stopped at ${MAX} results)`;
    return { content: out };
  },
};

export const grep: Tool = {
  name: 'grep',
  description: 'Search file contents with a regular expression (extended regex). Returns matching lines as path:line:text.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'File or directory to search (default: working directory)' },
      include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive search' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    const target = resolvePath(ctx.cwd, String(args.path ?? '.'));
    const refused = await approveRead(ctx, 'grep', target, true);
    if (refused) return { content: refused };
    const skipSecrets = !isSecretPath(target, ctx.cwd);
    const { out, timedOut } = await search(target, String(args.pattern), !!args.ignore_case, args.include ? String(args.include) : undefined);
    const stopped = timedOut ? `\n…(the search stopped after ${grepTimeout / 1000} s; narrow the pattern or path)` : '';
    if (!out.trim()) return { content: timedOut ? `No matches before the search stopped after ${grepTimeout / 1000} s; narrow the pattern or path.` : 'No matches.' };
    // Inside a search root that is not secret itself, matches in secret files are left out
    const lines = out.split('\n').filter((l) => l && !(skipSecrets && isSecretPath(/^(.*?):\d+:/.exec(l)?.[1] ?? '')));
    if (!lines.length) return { content: 'No matches.' };
    const shown = lines
      .slice(0, GREP_MAX_LINES)
      .map((l) => (l.startsWith(ctx.cwd + '/') ? l.slice(ctx.cwd.length + 1) : l))
      .map((l) => (l.length > GREP_LINE_CHARS ? `${l.slice(0, GREP_LINE_CHARS)}…(${l.length - GREP_LINE_CHARS} more characters)` : l));
    let { text, kept } = fitLines(shown, SEARCH_RESULT_CHARS);
    if (lines.length > kept) text += `\n…(${lines.length - kept} more matches; narrow with a tighter pattern, a path or include)`;
    return { content: truncate(text) + stopped };
  },
};

/** How long a grep search may run */
export const GREP_TIMEOUT = 30_000;
let grepTimeout = GREP_TIMEOUT;
/** For the tests: a shorter time cap (undefined: back to GREP_TIMEOUT) */
export function setGrepTimeout(ms: number | undefined): void {
  grepTimeout = ms ?? GREP_TIMEOUT;
}
const SEARCH_BUFFER = 20 * 1024 * 1024;
const RG_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', `${os.homedir()}/.cargo/bin`, '/usr/bin', '/bin'];
let rgPath: string | null | undefined;

/** ripgrep's path when it is installed (on PATH, or where Homebrew and cargo put it), else null. Looked up once. */
export function findRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath;
  rgPath = null;
  for (const dir of [...(process.env.PATH ?? '').split(':').filter(Boolean), ...RG_DIRS]) {
    const p = path.join(dir, 'rg');
    try {
      fsSync.accessSync(p, fsSync.constants.X_OK);
      if (fsSync.statSync(p).isFile()) {
        rgPath = p;
        break;
      }
    } catch {
      /* not here */
    }
  }
  return rgPath;
}

/** For the tests: forget the ripgrep lookup, or set it (null: use grep) */
export function setRipgrep(p: string | null | undefined): void {
  rgPath = p;
}

/**
 * Runs the search: ripgrep when it is installed (hidden files searched, .gitignore honoured, the fixed folders left
 * out), else grep -rnIE. Lines come as path:line:text either way. Stops after GREP_TIMEOUT with what it found so far.
 */
function search(target: string, pattern: string, ignoreCase: boolean, include?: string): Promise<{ out: string; timedOut: boolean }> {
  const rg = findRipgrep();
  let file: string;
  let argv: string[];
  if (rg) {
    file = rg;
    // Line-buffered: a search killed at its time cap has written every line it found (a pipe is block-buffered)
    argv = ['--no-heading', '--with-filename', '-n', '--hidden', '--no-require-git', '--color', 'never', '--no-messages', '--line-buffered'];
    if (ignoreCase) argv.push('-i');
    for (const d of IGNORED_DIRS) argv.push('--glob', `!${d}`);
    if (include) argv.push('--glob', include);
    argv.push('-e', pattern, target);
  } else {
    file = 'grep';
    argv = ['-rnIE', '--line-buffered'];
    if (ignoreCase) argv.push('-i');
    for (const d of IGNORED_DIRS) argv.push(`--exclude-dir=${d}`);
    if (include) argv.push(`--include=${include}`);
    argv.push('-e', pattern, target);
  }
  return new Promise((resolve, reject) => {
    execFile(file, argv, { maxBuffer: SEARCH_BUFFER, timeout: grepTimeout, killSignal: 'SIGKILL' }, (err, stdout) => {
      const e = err as (Error & { code?: unknown; killed?: boolean; signal?: string }) | null;
      // More output than the buffer holds: what it holds is plenty (the result keeps 300 lines)
      if (e?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ out: stdout ?? '', timedOut: false });
      if (e?.killed || (e && e.signal === 'SIGKILL')) return resolve({ out: stdout ?? '', timedOut: true });
      if (e && Number(e.code) === 1) return resolve({ out: '', timedOut: false });
      if (e && !stdout) return reject(e);
      resolve({ out: stdout, timedOut: false });
    });
  });
}
