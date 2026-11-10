import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { isSecretPath } from '../guard';
import type { Tool, ToolContext } from './types';
import { truncate } from './types';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', '.cache', 'target']);

export function resolvePath(cwd: string, p: string): string {
  const expanded = p.replace(/^~(?=$|\/)/, os.homedir());
  return path.resolve(cwd, expanded);
}

/**
 * A read of a secret path (keys, credentials, .env, the app's own data) asks first: the rules decide (Bypass runs it,
 * Auto mode's check or a card with "reads secrets" otherwise). Null when it may go on, else the message for the model.
 */
async function approveSecretRead(ctx: ToolContext, name: string, target: string): Promise<string | null> {
  if (!isSecretPath(target, ctx.cwd)) return null;
  const approval = await ctx.approve(name, target, target);
  return approval.ok ? null : approval.message;
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
    const refused = await approveSecretRead(ctx, 'read_file', file);
    if (refused) return { content: refused };
    const data = await fs.readFile(file, 'utf8');
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
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    const file = resolvePath(ctx.cwd, String(args.path));
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (!oldStr) throw new Error('old_string must not be empty');
    const data = await fs.readFile(file, 'utf8');
    let target = oldStr;
    let count = data.split(target).length - 1;
    if (count === 0) {
      // Models often reproduce the text with slightly different whitespace. Fall back to a
      // whitespace-tolerant match and, if it is unique, edit that exact span instead.
      const match = fuzzyFind(data, oldStr);
      if (match === null) throw new Error('old_string was not found in the file, even ignoring whitespace differences. Read the file and copy the text exactly.');
      if (match === 'ambiguous') throw new Error('old_string matches several places (ignoring whitespace); include more surrounding lines to make it unique.');
      target = match;
      count = data.split(target).length - 1;
    }
    if (count > 1 && !args.replace_all) throw new Error(`old_string occurs ${count} times; make it unique or set replace_all=true`);
    const preview = `${file}\n--- old\n${truncate(target, 800)}\n+++ new\n${truncate(newStr, 800)}`;
    const approval = await ctx.approve('edit_file', preview, file);
    if (!approval.ok) return { content: approval.message };
    ctx.beforeChange(file);
    const updated = args.replace_all ? data.split(target).join(newStr) : data.replace(target, () => newStr);
    await fs.writeFile(file, updated, 'utf8');
    return { content: `Edited ${file} (${count} replacement${count === 1 ? '' : 's'})` };
  },
};

/**
 * Finds `needle` in `haystack` comparing lines with leading/trailing whitespace stripped.
 * Returns the exact original text of the unique match, null if none, or 'ambiguous'.
 */
export function fuzzyFind(haystack: string, needle: string): string | null | 'ambiguous' {
  const want = needle.split('\n').map((l) => l.trim());
  while (want.length && !want[want.length - 1]) want.pop();
  while (want.length && !want[0]) want.shift();
  if (!want.length) return null;
  const lines = haystack.split('\n');
  const hits: string[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(lines.slice(i, i + want.length).join('\n'));
  }
  if (hits.length === 0) {
    // Last resort: compare with all whitespace removed (handles reflowed one-liners).
    const squash = (t: string) => t.replace(/\s+/g, '');
    const n = squash(needle);
    if (!n) return null;
    const h = squash(haystack);
    const first = h.indexOf(n);
    if (first < 0) return null;
    if (h.indexOf(n, first + 1) >= 0) return 'ambiguous';
    // Map the squashed span back to original offsets.
    let pos = 0;
    let start = -1;
    let end = -1;
    for (let k = 0; k < haystack.length && end < 0; k++) {
      if (/\s/.test(haystack[k])) continue;
      if (pos === first) start = k;
      pos++;
      if (pos === first + n.length) end = k + 1;
    }
    return start >= 0 && end > start ? haystack.slice(start, end) : null;
  }
  if (hits.length > 1 && new Set(hits).size > 1) return 'ambiguous';
  return hits[0];
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
    const refused = await approveSecretRead(ctx, 'list_directory', dir);
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
    const refused = await approveSecretRead(ctx, 'glob', root);
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
    let out = results.join('\n');
    if (results.length >= MAX) out += `\n…(stopped at ${MAX} results)`;
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
    const refused = await approveSecretRead(ctx, 'grep', target);
    if (refused) return { content: refused };
    const skipSecrets = !isSecretPath(target, ctx.cwd);
    const flags = ['-rnIE'];
    if (args.ignore_case) flags.push('-i');
    for (const d of IGNORED_DIRS) flags.push(`--exclude-dir=${d}`);
    if (args.include) flags.push(`--include=${String(args.include)}`);
    const out = await new Promise<string>((resolve, reject) => {
      execFile('grep', [...flags, '-e', String(args.pattern), target], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
        if (err && Number((err as { code?: unknown }).code) === 1) return resolve('');
        if (err && !stdout) return reject(err);
        resolve(stdout);
      });
    });
    if (!out.trim()) return { content: 'No matches.' };
    // Inside a search root that is not secret itself, matches in secret files are left out
    const lines = out.split('\n').filter((l) => l && !(skipSecrets && isSecretPath(/^(.*?):\d+:/.exec(l)?.[1] ?? '')));
    if (!lines.length) return { content: 'No matches.' };
    const shown = lines.slice(0, 300).map((l) => (l.startsWith(ctx.cwd + '/') ? l.slice(ctx.cwd.length + 1) : l));
    let text = shown.join('\n');
    if (lines.length > shown.length) text += `\n…(${lines.length - shown.length} more matches; narrow the pattern or path)`;
    return { content: truncate(text) };
  },
};
