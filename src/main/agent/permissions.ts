// The permission rules: per mode, whether an action runs, asks the user, or is refused, and the wording of the
// approval card's wider answers. Pure: the agent keeps the pending cards and the per-session allow lists.

import type { PermissionMode, StoredRules } from '../../shared/types';
import { siteCardLabels, type Site } from '../browser/policy';
import { guardCommand, guardWrite, isHomeScanRoot, isReadOnlyCommand, programsOf, SCAN_REASON } from '../guard';
import type { McpToolRef } from '../mcp';
import type { ApproveOptions } from '../tools';
import { alwaysAskReason, protectedWrite, PROTECTED_REASONS } from './auto-rules';

/** What the model is told when the user denies a card */
export const DENIED = 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.';
const PLAN_EDIT_BLOCKED = 'Not permitted in plan mode: describe this step in your plan instead.';
const PLAN_CMD_BLOCKED = 'Not permitted in plan mode: only read-only commands (ls, cat, grep, git status/log/diff …) run while planning. Describe this step in your plan instead.';
const PLAN_MCP_BLOCKED = 'Not permitted in plan mode: this MCP tool is not marked read-only. Describe this step in your plan instead.';
/** Programs that run whatever they are given: an allow rule for one of them does not skip Auto mode's check. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'python', 'python3', 'node', 'deno', 'bun', 'bunx', 'npx', 'uvx', 'perl', 'ruby', 'php', 'osascript', 'eval', 'xargs']);
/** The tools that read files: they ask only for a secret path, or grep and glob for a walk of the home folder (tools/fs.ts) */
const READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_directory']);
const SECRET_REASON = 'reads secrets';
/** The browser cards Auto mode's safety check decides (allow, block or ask the user); purchase and account always ask. */
export const CHECKED_BROWSER_CARDS: ReadonlySet<string> = new Set(['site', 'sensitive', 'eval']);
const PLAN_CUSTOM_BLOCKED ='Not permitted in plan mode: this action needs the user\'s approval, which plan mode does not ask for. Describe this step in your plan instead.';

/**
 * What the rules decide: run it, refuse it with this message, show a card (`custom`: a tool's own question, Allow and
 * Deny only), or, in Auto mode, let the safety check decide (`reason` and `programs`: what a card would say, should
 * the check be unavailable).
 */
export type ApprovalDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; message: string }
  | { kind: 'ask'; reason: string | null; programs: string[]; custom: boolean }
  | { kind: 'classify'; reason: string | null; programs: string[] };

/**
 * How Auto mode decides what its rules do not settle: `check` the safety check (classifier.ts), `paused` an approval
 * card (the check blocked too often in this session), `guard` the rule guard alone (no model can run the check):
 * guard reasons ask, the rest runs, as Auto mode did before it had a check.
 */
export type AutoLevel = 'check' | 'paused' | 'guard';

/** What the rules are decided against: the session's mode and folder, the project's saved rules, and what the user allowed this session. */
export interface ApprovalContext {
  mode: PermissionMode;
  /** Auto mode only (default 'guard') */
  auto?: AutoLevel;
  cwd: string;
  /** The "Always allow … in this project" rules saved for `cwd` */
  rules: StoredRules | undefined;
  /** The MCP tool the name stands for, when it is one (asked only once the rules reach MCP tools) */
  mcp(): McpToolRef | undefined;
  /** What the user allowed for the rest of this session (each asked only when the rules reach it) */
  allowed: {
    mcp(server: string): boolean;
    reason(reason: string): boolean;
    program(program: string): boolean;
    /** A custom action's key (ApproveOptions.sessionKey) the user allowed for this session */
    custom?(key: string): boolean;
  };
}

/**
 * Decides, per permission mode, whether an action runs, asks, or is refused. A browser card asks: the browser policy
 * (browser/policy.ts siteDecision, clickRule) already weighed the mode, the site and the user's lists, and a purchase
 * or an account asks in every mode; in Auto mode with its check running, a site, sensitive or eval card goes to the check. MCP tools: read-only ones run everywhere; the rest ask once per server (auto
 * mode asks only for destructive ones). A read of a secret path (read_file ~/.ssh/id_rsa) asks "reads secrets" in
 * every mode but Bypass, or goes to Auto mode's check. Plan mode refuses edits and commands that change anything, and asks for a read-only one the guard flags ("reads secrets"). Otherwise a protected
 * path asks every time (Allow and Deny only), a guard reason asks unless allowed; auto mode and Accept edits (or a saved rule) run the rest; a command runs when every
 * program in it is allowed. Auto mode with its safety check (ctx.auto 'check' or 'paused') sends what its rules (the
 * `checked` block below) do not settle to the check, MCP calls that are not read-only included.
 */
export function decideApproval(name: string, detail: string, target: string | undefined, opts: ApproveOptions, ctx: ApprovalContext): ApprovalDecision {
  const { mode, cwd, rules } = ctx;
  const isEdit = name === 'write_file' || name === 'edit_file';
  const isCmd = name === 'bash' || name === 'terminal_run';
  const allow: ApprovalDecision = { kind: 'allow' };
  const refuse = (message: string): ApprovalDecision => ({ kind: 'refuse', message });
  const ask = (reason: string | null, programs: string[], custom = false): ApprovalDecision => ({ kind: 'ask', reason, programs, custom });
  const checked = mode === 'auto' && (ctx.auto === 'check' || ctx.auto === 'paused');
  // What the check would decide: an approval card instead while Auto mode is paused
  const check = (reason: string | null, programs: string[]): ApprovalDecision => (ctx.auto === 'paused' ? ask(reason, programs, !!reason && PROTECTED_REASONS.has(reason)) : { kind: 'classify', reason, programs });
  // Only the site card has the wider answers; the rest (a sensitive site's act, a browser_eval, a purchase, an account) are Allow and Deny.
  // In Auto mode with its check running, a site, sensitive or eval card goes to the check (which may still ask);
  // purchase and account cards are the user's in every mode, and a paused or unavailable check shows the card.
  if (opts.browser) {
    if (mode === 'auto' && ctx.auto === 'check' && CHECKED_BROWSER_CARDS.has(opts.browser.card)) return { kind: 'classify', reason: opts.browser.reason ?? null, programs: [] };
    return ask(opts.browser.reason ?? null, [], opts.browser.card !== 'site');
  }
  if (opts.custom) {
    if (mode === 'plan') return refuse(PLAN_CUSTOM_BLOCKED);
    if (mode === 'bypass' && !opts.alwaysAsk) return allow;
    // The user answered a card for this very action "for this session" already
    if (opts.sessionKey && ctx.allowed.custom?.(opts.sessionKey)) return allow;
    return ask(null, [], true);
  }
  if (mode === 'bypass') return allow;
  const ref = ctx.mcp();
  if (ref) {
    if (mode === 'plan') return ref.readOnly ? allow : refuse(PLAN_MCP_BLOCKED);
    if (ref.readOnly || ctx.allowed.mcp(ref.server) || rules?.mcp?.includes(ref.server)) return allow;
    if (checked) return check(ref.destructive ? 'destructive MCP tool' : null, [ref.server]);
    if (mode === 'auto') return ref.destructive ? ask('destructive MCP tool', [ref.server]) : allow;
    return ask(null, [ref.server]);
  }
  // A protected path's reason ("writes a protected file", "modifies the .git directory") is never covered by a rule
  const reasonAllowed = (r: string) => !PROTECTED_REASONS.has(r) && (ctx.allowed.reason(r) || !!rules?.reasons?.includes(r));
  // A read tool asks only for a secret path, or grep and glob rooted at the home folder, /, /Users … (fs.ts decides
  // that; the reason follows from the root): every mode, Plan included, asks unless that reason is allowed; Auto mode
  // with its check sends it to the check.
  if (READ_TOOLS.has(name)) {
    const why = (name === 'grep' || name === 'glob') && target && isHomeScanRoot(target, cwd) ? SCAN_REASON : SECRET_REASON;
    if (reasonAllowed(why)) return allow;
    return checked ? check(why, []) : ask(why, []);
  }
  if (mode === 'plan') {
    if (isEdit) return refuse(PLAN_EDIT_BLOCKED);
    if (isCmd) {
      if (!isReadOnlyCommand(detail)) return refuse(PLAN_CMD_BLOCKED);
      // A read-only command the guard flags (cat ~/.aws/credentials: "reads secrets") asks with that reason
      const r = guardCommand(detail, cwd);
      return r && !reasonAllowed(r) ? ask(r, programsOf(detail)) : allow;
    }
    return allow;
  }
  if (!isEdit && !isCmd) return allow;
  const reason = isCmd ? guardCommand(detail, cwd) : target ? guardWrite(target, cwd) : null;
  const programs = isCmd ? programsOf(detail) : [];
  const programsAllowed = programs.length > 0 && programs.every((p) => ctx.allowed.program(p) || rules?.programs?.includes(p));
  if (checked) {
    // Auto mode with its check. Commands: sudo and deleting a critical folder ask whatever the check would say; read-only
    // commands run; then the user's allow rules: a guard reason they allowed, or programs they allowed for a command
    // the guard does not flag (a program rule never covers a force push), and never an interpreter, which runs anything
    // (as Claude Code drops such broad rules in Auto mode). The rest goes to the check.
    if (isCmd) {
      const always = alwaysAskReason(detail, cwd);
      if (always) return reasonAllowed(always) ? allow : ask(always, programs);
      if (!reason && isReadOnlyCommand(detail)) return allow;
      if (reason && reasonAllowed(reason)) return allow;
      if (!reason && programsAllowed && !programs.some((p) => INTERPRETERS.has(p))) return allow;
      return check(reason, programs);
    }
    // Edits: inside the working directory they run; a protected path goes to the check even when a rule allows it;
    // elsewhere a saved "writes outside the working directory" rule runs it.
    const guarded = target ? protectedWrite(target, cwd) : null;
    if (!reason && !guarded) return allow;
    if (!guarded && reason && reasonAllowed(reason)) return allow;
    return check(guarded ?? reason, []);
  }
  // A protected path (.vscode/tasks.json, .mcp.json, .git, ~/.zshrc …) asks every time, Allow and Deny only, whatever
  // the mode (but Bypass), the saved rules or the session allowed
  const guarded = isEdit && target ? protectedWrite(target, cwd) : reason && PROTECTED_REASONS.has(reason) ? reason : null;
  if (guarded) return ask(guarded, programs, true);
  if (reason && !reasonAllowed(reason)) return ask(reason, programs);
  if (mode === 'auto') return allow;
  if (isEdit && (mode === 'acceptEdits' || rules?.edits)) return allow;
  if (isCmd && programsAllowed) return allow;
  return ask(null, programs);
}

/**
 * The card's wider answers: "Allow git, npm for this session", "Always allow this server in this project"; for a
 * browser site card "Allow example.com for this session" and "Always allow example.com" (saved on this Mac, not per project).
 */
export function approvalLabels(name: string, reason: string | null, programs: string[], site?: Site): { alwaysLabel: string; projectLabel: string } {
  if (site) return siteCardLabels(site);
  const what = name.startsWith('mcp__')
    ? programs[0] ?? 'this server'
    : reason
    ? 'this kind of action'
    : name === 'bash' || name === 'terminal_run'
      ? programs.join(', ') || 'this command'
      : 'edits';
  return { alwaysLabel: `Allow ${what} for this session`, projectLabel: `Always allow ${what} in this project` };
}
