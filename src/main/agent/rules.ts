// Permission rules in Claude Code's format: `Tool` or `Tool(specifier)`, in three lists, allow, ask and deny.
// Parsing, the old saved shape, and matching. Pure but for the file system's real paths (symlinks).
//
//   Bash(npm run test:*)   Bash(git * main)   Bash(npm test)   Bash
//   Read(~/notes/**)  Edit(//tmp/scratch.txt)  Edit(src/**)  Write
//   WebFetch(domain:example.com)  WebSearch  mcp__github  mcp__github__get_issue  session_spawn (ask and deny only)
//
// Deny and ask settle a call before anything else (agent.ts prepareTool, ruleVerdict below): deny refuses in every
// mode, ask shows a card in every mode. Allow rules only widen what permissions.ts decideApproval already lets run:
// they never cover a protected path, sudo, a home-folder scan, a browser card or Plan mode.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionLists, StoredRules } from '../../shared/types';
import { allSimpleCommands, commandShape, judgedCommand, lineCommands, substitutions, words } from '../guard';

export type RuleListName = 'allow' | 'ask' | 'deny';
export const RULE_LISTS: RuleListName[] = ['deny', 'ask', 'allow'];

/** How much a Bash allow rule says (decideApproval weighs it): see bashAllow. */
export type BashStrength = 'broad' | 'program' | 'pattern' | 'strong' | 'exact';

type BashSpec =
  | { type: 'any' }
  | { type: 'exact'; text: string }
  | { type: 'pattern'; re: RegExp; bare: string | null; strong: boolean; program: string | null; firstWild: boolean };

interface PathPattern {
  anchor: 'abs' | 'home' | 'cwd';
  /** The pattern after its anchor, without a trailing / ('' : the anchor itself and all under it) */
  rest: string;
  re: RegExp;
  /** Has *, ? or [ */
  wild: boolean;
  /** Anchored at //, ~/ or / with a first segment that has no wildcard */
  anchoredLiteral: boolean;
}

export type Rule = { text: string; list: RuleListName } & (
  | { kind: 'bash'; spec: BashSpec }
  | { kind: 'path'; tool: 'Read' | 'Edit'; pattern: PathPattern | null }
  | { kind: 'webfetch'; domain: string | null }
  | { kind: 'websearch' }
  | { kind: 'mcp'; server: string; tool: string | null }
  | { kind: 'tool'; name: string }
);

export const BASH_TOOLS: ReadonlySet<string> = new Set(['bash', 'terminal_run']);
export const READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep', 'glob', 'list_directory']);
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

const DOCS = 'see docs/reference.md#permission-rules';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A literal piece of a Bash rule as a command is matched: quotes taken out as the command's words are, spaces collapsed */
const literal = (s: string): string => s.replace(/\s+/g, ' ').replace(/["']/g, '');

function parseBash(spec: string): BashSpec | string {
  let s = spec.trim();
  if (!s) return 'an empty command; write Bash for every command';
  if (s === '*') return { type: 'any' };
  // `:*` at the end is the same as ` *` (Bash(ls:*) = Bash(ls *)); anywhere else the colon is literal
  if (s.endsWith(':*')) {
    s = s.slice(0, -2).trimEnd();
    if (!s) return 'nothing before :*';
    s += ' *';
  }
  if (!s.includes('*')) {
    const text = words(s).join(' ');
    return text ? { type: 'exact', text } : 'an empty command';
  }
  const tokens = norm(s).split(' ');
  const lead = tokens.findIndex((t) => t.includes('*'));
  const firstWild = lead === 0;
  const parts = norm(s).split('*');
  const re = new RegExp(`^${parts.map((p) => escapeRe(literal(p))).join('.*')}$`, 's');
  // A trailing ` *` that is the only wildcard also matches the bare command: Bash(ls *) matches `ls`
  const stars = (s.match(/\*/g) ?? []).length;
  const bare = stars === 1 && norm(s).endsWith(' *') ? literal(norm(s).slice(0, -2)) : null;
  const program = tokens.length === 2 && tokens[1] === '*' && !tokens[0].includes('*') ? literal(tokens[0]) : null;
  return { type: 'pattern', re, bare, strong: lead >= 2, program, firstWild };
}

/** A gitignore-style glob as a regular expression over a path relative to its anchor. */
function globSource(g: string): string | null {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (g.startsWith('**/', i) && (i === 0 || g[i - 1] === '/')) {
      out += '(?:.*/)?';
      i += 2;
    } else if (g.startsWith('/**', i) && i + 3 === g.length) {
      out += '(?:/.*)?';
      i += 2;
    } else if (g.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = g.indexOf(']', i + 2);
      if (end < 0) return null;
      let body = g.slice(i + 1, end);
      if (body.startsWith('!')) body = '^' + body.slice(1);
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else out += escapeRe(c);
  }
  return out;
}

function parsePath(spec: string, list: RuleListName): PathPattern | string {
  const s = spec.trim();
  if (!s) return 'an empty path; write the tool alone for every path';
  if (s.startsWith('!')) return '! patterns are not supported';
  let anchor: PathPattern['anchor'];
  let rest: string;
  if (s.startsWith('//')) [anchor, rest] = ['abs', s.slice(2)];
  else if (s === '~' || s.startsWith('~/')) [anchor, rest] = ['home', s.slice(2)];
  else if (s.startsWith('~')) return 'only ~/ is understood, not ~user';
  else if (s.startsWith('/')) [anchor, rest] = ['cwd', s.slice(1)];
  else [anchor, rest] = ['cwd', s.startsWith('./') ? s.slice(2) : s];
  rest = rest.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (rest.split('/').some((seg) => seg === '..' || seg === '.')) return 'no . or .. segments; use // or ~/ for a path outside the project';
  const src = globSource(rest);
  if (src === null) return 'an unclosed [ in the pattern';
  const wild = /[*?[]/.test(rest);
  // gitignore: a pattern with no slash matches at any depth; for ask and deny, so does a single folder with /**
  const floating = anchor === 'cwd' && !s.startsWith('/') && (!rest.includes('/') || (list !== 'allow' && /^[^/*?[]+\/\*\*$/.test(rest)));
  const re = rest ? new RegExp(`^${floating ? '(?:.*/)?' : ''}${src}$`, 's') : /^.*$/s;
  const first = rest.split('/')[0] ?? '';
  const anchoredLiteral = (anchor !== 'cwd' || s.startsWith('/')) && !!first && !/[*?[]/.test(first);
  return { anchor, rest, re, wild, anchoredLiteral };
}

function parseDomain(spec: string): { domain: string } | { error: string } {
  const m = /^\s*domain\s*:\s*(\S+)\s*$/.exec(spec);
  if (!m) return { error: 'write WebFetch(domain:example.com)' };
  const d = m[1].toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9*][a-z0-9*.-]*$/.test(d)) return { error: `not a domain: ${m[1]}` };
  return { domain: d };
}

/**
 * Parses one rule string for one list. The error says why it is not a rule; a string that does not parse is never
 * read as a broader rule.
 */
export function parseRule(raw: unknown, list: RuleListName): { rule: Rule } | { error: string } {
  if (typeof raw !== 'string') return { error: 'not a string' };
  const text = raw.trim();
  if (!text) return { error: 'an empty rule' };
  const m = /^([A-Za-z_][A-Za-z0-9_.*-]*)(?:\((.*)\))?$/s.exec(text);
  if (!m) return { error: `write Tool or Tool(specifier); ${DOCS}` };
  const [, tool, spec] = m;
  const base = { text, list };
  if (tool.startsWith('mcp__')) {
    if (spec !== undefined) return { error: 'an MCP rule takes no (…): write mcp__server or mcp__server__tool' };
    const mm = /^mcp__(.+?)(?:__(.+))?$/.exec(tool);
    if (!mm || !mm[1] || mm[1].includes('*')) return { error: 'write mcp__server or mcp__server__tool' };
    const t = mm[2] === '*' ? null : mm[2] ?? null;
    if (t?.includes('*')) return { error: 'only mcp__server__* takes a wildcard' };
    return { rule: { ...base, kind: 'mcp', server: mm[1], tool: t } };
  }
  switch (tool) {
    case 'Bash': {
      if (spec === undefined) return { rule: { ...base, kind: 'bash', spec: { type: 'any' } } };
      const b = parseBash(spec);
      return typeof b === 'string' ? { error: b } : { rule: { ...base, kind: 'bash', spec: b } };
    }
    case 'Read':
    case 'Edit':
    case 'Write': {
      const t = tool === 'Read' ? 'Read' : 'Edit';
      if (spec === undefined || spec.trim() === '*' || spec.trim() === '**') return { rule: { ...base, kind: 'path', tool: t, pattern: null } };
      const p = parsePath(spec, list);
      return typeof p === 'string' ? { error: p } : { rule: { ...base, kind: 'path', tool: t, pattern: p } };
    }
    case 'WebFetch': {
      // A site the agent may visit unasked is approved by its origin in Settings → Browser, so the browser's own
      // approvals stay the only way in
      if (list === 'allow') return { error: 'allow sites in Settings → Browser; WebFetch rules may ask or deny' };
      if (spec === undefined) return { rule: { ...base, kind: 'webfetch', domain: null } };
      const d = parseDomain(spec);
      return 'error' in d ? d : { rule: { ...base, kind: 'webfetch', domain: d.domain } };
    }
    case 'WebSearch':
      if (list === 'allow') return { error: 'web searches are allowed on their card; WebSearch rules may ask or deny' };
      if (spec !== undefined) return { error: 'WebSearch takes no (…)' };
      return { rule: { ...base, kind: 'websearch' } };
  }
  if (/^[a-z][a-z0-9_]*$/.test(tool)) {
    if (list === 'allow') return { error: 'allow rules take Bash, Read, Edit, Write or mcp__…; a tool name may ask or deny' };
    if (spec !== undefined) return { error: `${tool} takes no (…)` };
    return { rule: { ...base, kind: 'tool', name: tool } };
  }
  return { error: `unknown tool ${tool}; ${DOCS}` };
}

// ---------- The rule sets ----------

/** A rule that does not parse, where it was read */
export interface InvalidRule {
  list: RuleListName;
  text: string;
  error: string;
  source: 'project' | 'global';
}

export interface CompiledRules {
  allow: Rule[];
  ask: Rule[];
  deny: Rule[];
  /** Guard reasons saved by "Always allow … in this project" ("uses sudo") */
  reasons: string[];
  invalid: InvalidRule[];
}

const PLAIN_PROGRAM = /^[A-Za-z0-9_][A-Za-z0-9_.+@-]*$/;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * A project's stored rules in today's shape: allow / ask / deny strings and reasons. The shape before 0.16 (programs,
 * edits, mcp) becomes the same rules: program p → Bash(p:*), edits → Edit, server s → mcp__s. A program or server name
 * the grammar cannot hold stays in its old field (and keeps its old meaning).
 */
export function storedLists(stored: StoredRules | undefined): Required<Pick<StoredRules, 'allow' | 'ask' | 'deny' | 'reasons'>> & Pick<StoredRules, 'programs' | 'mcp'> {
  const s = stored ?? {};
  const allow = [...strings(s.allow)];
  const programs: string[] = [];
  const mcp: string[] = [];
  for (const p of strings(s.programs)) {
    if (PLAIN_PROGRAM.test(p)) allow.push(`Bash(${p}:*)`);
    else programs.push(p);
  }
  if (s.edits === true) allow.push('Edit');
  for (const m of strings(s.mcp)) {
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(m) && !m.includes('__')) allow.push(`mcp__${m}`);
    else mcp.push(m);
  }
  const out: ReturnType<typeof storedLists> = { allow: [...new Set(allow)], ask: [...new Set(strings(s.ask))], deny: [...new Set(strings(s.deny))], reasons: [...new Set(strings(s.reasons))] };
  if (programs.length) out.programs = programs;
  if (mcp.length) out.mcp = mcp;
  return out;
}

/** The stored rules converted (storedLists), with empty lists left out; undefined when nothing is left. */
export function normalizeStoredRules(stored: StoredRules | undefined): StoredRules | undefined {
  const l = storedLists(stored);
  const out: StoredRules = {};
  for (const k of ['allow', 'ask', 'deny', 'reasons', 'programs', 'mcp'] as const) if (l[k]?.length) out[k] = l[k];
  return Object.keys(out).length ? out : undefined;
}

const cache = new WeakMap<object, WeakMap<object, CompiledRules>>();
const NONE = {};

/** The project's rules and the global ones (the user's settings.json), parsed. Cached per pair of objects. */
export function compileRules(stored: StoredRules | undefined, global?: PermissionLists): CompiledRules {
  const a = (stored ?? NONE) as object;
  const b = (global ?? NONE) as object;
  const hit = cache.get(a)?.get(b);
  if (hit) return hit;
  const out: CompiledRules = { allow: [], ask: [], deny: [], reasons: [], invalid: [] };
  const lists = storedLists(stored);
  const add = (list: RuleListName, texts: string[], source: InvalidRule['source']) => {
    for (const t of texts) {
      const r = parseRule(t, list);
      if ('rule' in r) out[list].push(r.rule);
      else out.invalid.push({ list, text: t, error: r.error, source });
    }
  };
  for (const list of RULE_LISTS) add(list, lists[list], 'project');
  // Old names the grammar cannot hold: a program or server rule as before
  for (const p of lists.programs ?? []) out.allow.push({ text: `Bash(${p}:*)`, list: 'allow', kind: 'bash', spec: { type: 'pattern', re: /^(?!)$/, bare: null, strong: false, program: p, firstWild: false } });
  for (const m of lists.mcp ?? []) out.allow.push({ text: `mcp__${m}`, list: 'allow', kind: 'mcp', server: m, tool: null });
  out.reasons = lists.reasons;
  if (global) for (const list of RULE_LISTS) add(list, strings((global as Record<string, unknown>)[list]), 'global');
  let inner = cache.get(a);
  if (!inner) cache.set(a, (inner = new WeakMap()));
  inner.set(b, out);
  return out;
}

// ---------- Bash ----------

/** What a Bash rule is matched against: the program and its arguments, quotes taken out, one space apart. */
function matchTexts(simple: string, deny: boolean): { texts: string[]; assigns: boolean; program: string; writes: string[] } {
  const { argv, assigns, writes } = commandShape(simple);
  const text = argv.join(' ');
  const texts = [text];
  // Deny and ask also see /bin/rm as rm
  if (deny && argv[0] && argv[0].includes('/')) texts.push([path.basename(argv[0]), ...argv.slice(1)].join(' '));
  return { texts, assigns, program: path.basename(argv[0] ?? ''), writes };
}

function bashSpecMatches(spec: BashSpec, texts: string[], program: string): boolean {
  if (spec.type === 'any') return true;
  if (spec.type === 'exact') return texts.includes(spec.text);
  if (spec.program !== null && program === spec.program) return true;
  return texts.some((t) => spec.re.test(t) || (spec.bare !== null && t === spec.bare));
}

function strengthOf(rule: Rule & { kind: 'bash' }): BashStrength {
  const s = rule.spec;
  if (s.type === 'any') return 'broad';
  if (s.type === 'exact') return 'exact';
  if (s.firstWild) return 'broad';
  if (s.strong) return 'strong';
  return s.program !== null ? 'program' : 'pattern';
}

const RANK: Record<BashStrength, number> = { broad: 0, program: 1, pattern: 2, strong: 3, exact: 4 };

/**
 * True when allow rules cannot see what a command runs: $(…), backticks, <(…), eval, a here-document, an operator with
 * nothing after it, or more commands than the parser follows.
 */
export function opaqueCommand(command: string): boolean {
  const raw = command.trim();
  if (!raw) return true;
  if (substitutions(raw).found) return true;
  if (/(^|[^<])<<(?!<)/.test(raw)) return true;
  if (/(&&|\|\||\|)\s*$/.test(raw)) return true;
  const all = allSimpleCommands(raw);
  if (all.length >= 200) return true;
  return all.some((s) => path.basename(commandShape(s).argv[0] ?? '') === 'eval');
}

export interface BashAllow {
  /** Every command the line runs is covered by an allow rule or a program the session allowed */
  covered: boolean;
  /** Every command matched a rule that names more than the program (or an exact command), with no redirection into a file: it also covers the guard's soft reasons */
  strong: boolean;
  /** …and each by an exact command (what a "reads secrets" command needs) */
  exact: boolean;
  /** A command was covered only by bare Bash or a rule that starts with a wildcard (Auto mode still checks) */
  broad: boolean;
}

/**
 * What the allow rules (and the programs the user allowed for the session) say about a shell command: every command
 * it runs (those inside sh -c, xargs and find -exec included) must be covered. A command the parser cannot see
 * through is covered by the session's programs alone, as before rules had patterns.
 */
export function bashAllow(command: string, rules: CompiledRules, sessionProgram: (p: string) => boolean): BashAllow {
  const none: BashAllow = { covered: false, strong: false, exact: false, broad: false };
  const raw = command.trim();
  const simples = allSimpleCommands(raw);
  if (!simples.length) return none;
  const allows = rules.allow.filter((r): r is Rule & { kind: 'bash' } => r.kind === 'bash');
  if (opaqueCommand(raw)) {
    const programs = simples.map((s) => path.basename(commandShape(s).argv[0] ?? '')).filter(Boolean);
    return { ...none, covered: programs.length > 0 && programs.every(sessionProgram) };
  }
  let strong = true;
  let exact = true;
  let broad = false;
  for (const simple of simples) {
    const m = matchTexts(simple, false);
    if (!m.program) continue;
    let best: BashStrength | null = null;
    for (const r of allows) {
      // Only a whole-program rule (what "Always allow git" saves) matches past a leading VAR=value, as it always did
      if (m.assigns && !(r.spec.type === 'pattern' && r.spec.program !== null)) continue;
      if (!bashSpecMatches(r.spec, m.texts, m.program)) continue;
      const s = strengthOf(r);
      if (best === null || RANK[s] > RANK[best]) best = s;
    }
    const bySession = sessionProgram(m.program);
    if (best === null && !bySession) return none;
    if (best === null || RANK[best] < RANK.strong || m.writes.length) strong = false;
    if (best !== 'exact' || m.writes.length) exact = false;
    if (!bySession && best === 'broad') broad = true;
  }
  return { covered: true, strong, exact: exact && strong, broad };
}

// ---------- Paths ----------

/** The real path of `p`, or of its nearest existing folder with the rest appended (a file not written yet). */
export function realPath(p: string): string {
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

export const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir());

function anchorBase(p: PathPattern, cwd: string): string {
  return p.anchor === 'abs' ? '/' : p.anchor === 'home' ? os.homedir() : path.resolve(cwd);
}

function underBase(pattern: PathPattern, base: string, file: string): boolean {
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (!pattern.rest) return true;
  if (!rel) return false;
  // gitignore: a rule that matches a folder covers everything in it
  const segs = rel.split(path.sep);
  for (let i = segs.length; i >= 1; i--) if (pattern.re.test(segs.slice(0, i).join('/'))) return true;
  return false;
}

/** One path against a pattern: at the anchor as written and at its real location (/tmp is /private/tmp). */
function pathMatches(pattern: PathPattern, cwd: string, file: string): boolean {
  const base = anchorBase(pattern, cwd);
  const bases = [...new Set([base, realPath(base)])];
  return bases.some((b) => underBase(pattern, b, file));
}

/**
 * A path rule against the path a tool will use and its real path (a symlink): allow needs both to match, ask and
 * deny either.
 */
export function pathRuleMatches(rule: Rule & { kind: 'path' }, target: string, cwd: string): boolean {
  if (!rule.pattern) return true;
  const requested = path.resolve(cwd, expandHome(target));
  const real = realPath(requested);
  const m = (f: string) => pathMatches(rule.pattern!, cwd, f);
  return rule.list === 'allow' ? m(requested) && m(real) : m(requested) || m(real);
}

export interface PathAllow {
  /** A rule of this tool covers the path (bare Edit, Edit(src/**) …) */
  any: boolean;
  /** …one anchored at //, ~/ or / with a literal first segment (covers "writes outside the working directory") */
  anchored: boolean;
  /** …one with no wildcard (covers "reads secrets") */
  exact: boolean;
}

export function pathAllow(tool: 'Read' | 'Edit', target: string, cwd: string, rules: CompiledRules): PathAllow {
  // The path as the tool names it and its real path must each be matched by an allow rule; a flag holds only when
  // rules with that property match both
  const requested = path.resolve(cwd, expandHome(target));
  const real = realPath(requested);
  const req = { any: false, anchored: false, exact: false };
  const rea = { any: false, anchored: false, exact: false };
  for (const r of rules.allow) {
    if (r.kind !== 'path' || r.tool !== tool) continue;
    for (const [file, out] of [[requested, req], [real, rea]] as const) {
      if (r.pattern && !pathMatches(r.pattern, cwd, file)) continue;
      out.any = true;
      if (r.pattern?.anchoredLiteral) out.anchored = true;
      if (r.pattern && !r.pattern.wild) out.exact = true;
    }
  }
  return { any: req.any && rea.any, anchored: req.anchored && rea.anchored, exact: req.exact && rea.exact };
}

// ---------- MCP and domains ----------

/** An MCP rule against a tool name (mcp__server__tool) and the server it belongs to. */
export function mcpRuleMatches(rule: Rule & { kind: 'mcp' }, name: string, server?: string): boolean {
  if (rule.tool !== null) return name === `mcp__${rule.server}__${rule.tool}`;
  return name.startsWith(`mcp__${rule.server}__`) || (!!server && server === rule.server);
}

export function domainMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return h.endsWith(pattern.slice(1));
  const a = pattern.split('.');
  const b = h.split('.');
  return a.length === b.length && a.every((x, i) => x === b[i] || (x.includes('*') && new RegExp(`^${x.split('*').map(escapeRe).join('[^.]*')}$`).test(b[i])));
}

// ---------- Deny and ask ----------

export interface RuleVerdict {
  list: 'deny' | 'ask';
  rule: string;
}

const argString = (args: unknown, key: string): string | undefined => {
  const v = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : undefined;
};

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function ruleMatchesCall(rule: Rule, name: string, args: unknown, cwd: string, server?: string): boolean {
  switch (rule.kind) {
    case 'tool':
      return rule.name === name;
    case 'websearch':
      return name === 'web_search';
    case 'webfetch': {
      if (name !== 'web_fetch') return false;
      if (rule.domain === null) return true;
      const host = hostOf(argString(args, 'url'));
      // A URL that does not parse is matched as the widest rule would: deny and ask apply
      return host === null || domainMatches(rule.domain, host);
    }
    case 'mcp':
      return name.startsWith('mcp__') && mcpRuleMatches(rule, name, server);
    case 'path': {
      const reads = READ_TOOLS.has(name);
      const edits = EDIT_TOOLS.has(name);
      // A Read deny rule also refuses writes and edits of the same path, as in Claude Code
      if (!(rule.tool === 'Read' ? reads || (edits && rule.list === 'deny') : edits)) return false;
      const p = argString(args, 'path') ?? (reads && name !== 'read_file' ? '.' : undefined);
      if (p === undefined) return rule.pattern === null;
      return pathRuleMatches(rule, p, cwd);
    }
    case 'bash': {
      if (!BASH_TOOLS.has(name)) return false;
      // bash's path is matched as `cd <path> && <command>`, as its card shows it
      const command = judgedCommand(name, args, cwd) ?? '';
      if (rule.spec.type === 'any') return true;
      // deny and ask look through sudo and doas too (sudo -u root rm x is rm x); allow rules do not
      for (const simple of lineCommands(command.trim())) {
        const m = matchTexts(simple, true);
        if (bashSpecMatches(rule.spec, m.texts, m.program)) return true;
      }
      return false;
    }
  }
}

/**
 * What the deny and ask rules say about a tool call, deny first: the first rule that matches, or null. Bash: any
 * command the line runs (in a substitution, sh -c, xargs, find -exec or after sudo too). Paths: the path or its real path.
 */
export function ruleVerdict(rules: CompiledRules, name: string, args: unknown, cwd: string, server?: string): RuleVerdict | null {
  for (const list of ['deny', 'ask'] as const) {
    for (const r of rules[list]) if (ruleMatchesCall(r, name, args, cwd, server)) return { list, rule: r.text };
  }
  return null;
}

/** What the model reads when a deny rule refuses a call */
export function deniedByRule(rule: string): string {
  return `Not permitted: the user's deny rule ${rule} refuses this. Do not retry it or work around it; continue with other work, or ask the user.`;
}

/** The rule strings an "Always allow … in this project" answer saves */
export function cardRules(kind: 'program' | 'edits' | 'mcp', values: string[]): { allow: string[]; programs: string[]; mcp: string[] } {
  const out = { allow: [] as string[], programs: [] as string[], mcp: [] as string[] };
  if (kind === 'edits') out.allow.push('Edit');
  else if (kind === 'program') for (const p of values) (PLAIN_PROGRAM.test(p) ? out.allow : out.programs).push(PLAIN_PROGRAM.test(p) ? `Bash(${p}:*)` : p);
  else for (const s of values) (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) && !s.includes('__') ? out.allow : out.mcp).push(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(s) && !s.includes('__') ? `mcp__${s}` : s);
  return out;
}
