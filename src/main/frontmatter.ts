// A small reader for the YAML frontmatter at the top of SKILL.md and command files. It covers the subset skills use:
// `key: value`, quoted strings, `|` and `>` block scalars, plain values that run on over indented lines, booleans,
// numbers, null, inline `[a, b]` and `- item` lists, one level of nested `key: value` maps, `#` comments, CRLF and a
// BOM. It never throws: a line it cannot read is reported by its line number and the rest is still read.

export type FmValue = string | number | boolean | null | FmValue[] | { [key: string]: FmValue };

export interface Frontmatter {
  /** True when the text starts with a --- line */
  present: boolean;
  /** The keys read, in file order */
  data: Record<string, FmValue>;
  /** The text after the closing --- (the whole text when there is no frontmatter) */
  body: string;
  /** The first problem: its message and its line in the file (1-based) */
  error?: { line: number; message: string };
}

const KEY_RE = /^([A-Za-z0-9_][\w.-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

/** Splits the text into frontmatter and body, and reads the frontmatter. */
export function parseFrontmatter(raw: string): Frontmatter {
  const text = String(raw ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (!/^---[ \t]*$/.test(lines[0] ?? '')) return { present: false, data: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end < 0) return { present: true, data: {}, body: lines.slice(1).join('\n'), error: { line: 1, message: 'no closing ---' } };
  const { data, error } = parseYamlSubset(lines.slice(1, end), 2);
  return { present: true, data, body: lines.slice(end + 1).join('\n'), error };
}

/** Reads the key/value lines of a frontmatter block. `firstLine` is the file line number of lines[0]. */
export function parseYamlSubset(lines: string[], firstLine = 1): { data: Record<string, FmValue>; error?: { line: number; message: string } } {
  const data: Record<string, FmValue> = {};
  let error: { line: number; message: string } | undefined;
  const fail = (i: number, message: string) => {
    error ??= { line: i + firstLine, message };
  };
  const indentOf = (s: string) => /^[ \t]*/.exec(s)![0];
  const blank = (s: string) => /^\s*(#.*)?$/.test(s);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) {
      fail(i, 'unexpected indented line');
      i++;
      continue;
    }
    const m = KEY_RE.exec(line);
    if (!m) {
      fail(i, 'expected "key: value"');
      i++;
      continue;
    }
    const key = m[1];
    const rest = (m[2] ?? '').trim();
    // The lines that belong to this key: blank ones and those indented under it
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) j++;
    // Trailing blank lines belong to no one
    let last = j;
    while (last > i + 1 && lines[last - 1].trim() === '') last--;
    const more = lines.slice(i + 1, last);
    if (more.some((l) => l.trim() && indentOf(l).includes('\t'))) fail(i + 1, 'tabs are not allowed for indentation');
    try {
      data[key] = readValue(rest, more, (k, msg) => fail(i + 1 + k, msg));
    } catch {
      fail(i, 'could not read the value');
    }
    i = j;
  }
  return { data, error };
}

function readValue(rest: string, more: string[], fail: (k: number, msg: string) => void): FmValue {
  const block = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(rest);
  if (block) return blockScalar(block[1] === '>', block[2] || block[4], more);
  if (rest === '' || rest.startsWith('#')) {
    const content = more.filter((l) => l.trim() && !/^\s*#/.test(l));
    if (!content.length) return null;
    if (content.every((l) => /^\s*-(\s|$)/.test(l))) return content.map((l) => scalar(l.trim().replace(/^-\s*/, ''), fail, 0));
    if (content.every((l) => KEY_RE.test(l.trim()))) {
      const obj: Record<string, FmValue> = {};
      for (const l of content) {
        const km = KEY_RE.exec(l.trim())!;
        obj[km[1]] = scalar((km[2] ?? '').trim(), fail, 0);
      }
      return obj;
    }
    return plain(content.map((l) => l.trim()).join(' '));
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    // A quoted string may run on over the indented lines
    const joined = [rest, ...more.map((l) => l.trim())].join('\n');
    const q = quoted(joined);
    if (!q) {
      fail(0, 'a quoted value has no closing quote');
      return rest;
    }
    if (q.rest.replace(/#.*$/, '').trim()) fail(0, 'text after a closing quote');
    return q.value;
  }
  if (rest.startsWith('[')) {
    const all = [rest, ...more.map((l) => l.trim())].join(' ').replace(/\s+#.*$/, '');
    if (!all.endsWith(']')) {
      fail(0, 'a [list] has no closing ]');
      return all;
    }
    return splitFlow(all.slice(1, -1)).map((s) => scalar(s, fail, 0));
  }
  // A plain value, folded over the indented lines that follow it
  const parts = [stripComment(rest), ...more.filter((l) => l.trim()).map((l) => stripComment(l.trim()))].filter(Boolean);
  if (parts.length === 1) return plain(parts[0]);
  return parts.join(' ');
}

function stripComment(s: string): string {
  return s.replace(/(^|\s)#.*$/, '').trim();
}

/** A single value: quoted, a flow list, or plain */
function scalar(s: string, fail: (k: number, msg: string) => void, k: number): FmValue {
  s = s.trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = quoted(s);
    if (q) return q.value;
    fail(k, 'a quoted value has no closing quote');
    return s;
  }
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map((x) => scalar(x, fail, k));
  return plain(stripComment(s));
}

function plain(s: string): FmValue {
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (s === '' || /^(null|Null|NULL|~)$/.test(s)) return null;
  if (/^[-+]?(\d+|\d*\.\d+)$/.test(s)) return Number(s);
  return s;
}

/** Reads a quoted string at the start of s, which may span lines (folded as YAML folds them). */
function quoted(s: string): { value: string; rest: string } | null {
  const q = s[0];
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (q === "'" && c === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return { value: out, rest: s.slice(i + 1) };
    }
    if (q === '"' && c === '\\') {
      const n = s[++i];
      const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', ' ': ' ', '\n': '' };
      if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
        i += 4;
      } else out += map[n] ?? n ?? '';
      continue;
    }
    if (q === '"' && c === '"') return { value: out, rest: s.slice(i + 1) };
    if (c === '\n') {
      // A line break in the source folds: one becomes a space, each further one a newline
      let n = 1;
      while (s[i + 1] === '\n') {
        n++;
        i++;
      }
      out = out.replace(/[ \t]+$/, '') + (n === 1 ? ' ' : '\n'.repeat(n - 1));
      continue;
    }
    out += c;
  }
  return null;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  for (const c of s) {
    if (q) {
      cur += c;
      if (c === q) q = '';
    } else if (c === '"' || c === "'") {
      q = c;
      cur += c;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** `|` keeps line breaks, `>` folds them; chomping: `-` strips the final newline, `+` keeps all, default keeps one. */
function blockScalar(folded: boolean, chomp: string, more: string[]): string {
  const first = more.find((l) => l.trim());
  if (!first) return '';
  const ind = /^[ \t]*/.exec(first)![0].length;
  const lines = more.map((l) => (l.trim() ? l.slice(Math.min(ind, /^[ \t]*/.exec(l)![0].length)) : ''));
  let text: string;
  if (!folded) text = lines.join('\n');
  else {
    // Lines join with a space; a blank line stands for one newline; more-indented lines keep their breaks
    text = '';
    let prev: 'start' | 'text' | 'blank' | 'more' = 'start';
    for (const l of lines) {
      if (l === '') {
        text += '\n';
        prev = 'blank';
      } else if (/^\s/.test(l)) {
        if (prev === 'text' || prev === 'more') text += '\n';
        text += l;
        prev = 'more';
      } else {
        if (prev === 'text') text += ' ';
        else if (prev === 'more') text += '\n';
        text += l;
        prev = 'text';
      }
    }
  }
  if (chomp === '-') return text.replace(/\n+$/, '');
  if (chomp === '+') return text + '\n';
  return text.replace(/\n*$/, '\n');
}
