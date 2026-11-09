// The permission rules: per mode, whether an action runs, asks the user, or is refused, and the wording of the
// approval card's wider answers. Pure: the agent keeps the pending cards and the per-session allow lists.

import type { PermissionMode, StoredRules } from '../../shared/types';
import { guardCommand, guardWrite, isReadOnlyCommand, programsOf } from '../guard';
import type { McpToolRef } from '../mcp';
import type { ApproveOptions } from '../tools';

/** What the model is told when the user denies a card */
export const DENIED = 'Not permitted: the user denied this action. Do not retry it; explain what you would have done and continue or stop.';
const PLAN_EDIT_BLOCKED = 'Not permitted in plan mode: describe this step in your plan instead.';
const PLAN_CMD_BLOCKED = 'Not permitted in plan mode: only read-only commands (ls, cat, grep, git status/log/diff …) run while planning. Describe this step in your plan instead.';
const PLAN_MCP_BLOCKED = 'Not permitted in plan mode: this MCP tool is not marked read-only. Describe this step in your plan instead.';
const PLAN_CUSTOM_BLOCKED = 'Not permitted in plan mode: this action needs the user\'s approval, which plan mode does not ask for. Describe this step in your plan instead.';

/** What the rules decide: run it, refuse it with this message, or show a card (`custom`: a tool's own question, Allow and Deny only). */
export type ApprovalDecision = { kind: 'allow' } | { kind: 'refuse'; message: string } | { kind: 'ask'; reason: string | null; programs: string[]; custom: boolean };

/** What the rules are decided against: the session's mode and folder, the project's saved rules, and what the user allowed this session. */
export interface ApprovalContext {
  mode: PermissionMode;
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
  };
}

/**
 * Decides, per permission mode, whether an action runs, asks, or is refused. MCP tools: read-only ones run
 * everywhere; the rest ask once per server (auto mode asks only for destructive ones). Plan mode refuses edits and
 * commands that change anything. Otherwise a guard reason asks unless allowed; auto mode and Accept edits (or a
 * saved rule) run the rest; a command runs when every program in it is allowed.
 */
export function decideApproval(name: string, detail: string, target: string | undefined, opts: ApproveOptions, ctx: ApprovalContext): ApprovalDecision {
  const { mode, cwd, rules } = ctx;
  const isEdit = name === 'write_file' || name === 'edit_file';
  const isCmd = name === 'bash' || name === 'terminal_run';
  const allow: ApprovalDecision = { kind: 'allow' };
  const refuse = (message: string): ApprovalDecision => ({ kind: 'refuse', message });
  const ask = (reason: string | null, programs: string[], custom = false): ApprovalDecision => ({ kind: 'ask', reason, programs, custom });
  if (opts.custom) {
    if (mode === 'plan') return refuse(PLAN_CUSTOM_BLOCKED);
    if (mode === 'bypass' && !opts.alwaysAsk) return allow;
    return ask(null, [], true);
  }
  if (mode === 'bypass') return allow;
  const ref = ctx.mcp();
  if (ref) {
    if (mode === 'plan') return ref.readOnly ? allow : refuse(PLAN_MCP_BLOCKED);
    if (ref.readOnly || ctx.allowed.mcp(ref.server) || rules?.mcp?.includes(ref.server)) return allow;
    if (mode === 'auto') return ref.destructive ? ask('destructive MCP tool', [ref.server]) : allow;
    return ask(null, [ref.server]);
  }
  if (mode === 'plan') {
    if (isEdit) return refuse(PLAN_EDIT_BLOCKED);
    if (isCmd) return isReadOnlyCommand(detail) ? allow : refuse(PLAN_CMD_BLOCKED);
    return allow;
  }
  if (!isEdit && !isCmd) return allow;
  const reason = isCmd ? guardCommand(detail, cwd) : target ? guardWrite(target, cwd) : null;
  const programs = isCmd ? programsOf(detail) : [];
  if (reason && !ctx.allowed.reason(reason) && !rules?.reasons?.includes(reason)) return ask(reason, programs);
  if (mode === 'auto') return allow;
  if (isEdit && (mode === 'acceptEdits' || rules?.edits)) return allow;
  if (isCmd && programs.length && programs.every((p) => ctx.allowed.program(p) || rules?.programs?.includes(p))) return allow;
  return ask(null, programs);
}

/** The card's wider answers: "Allow git, npm for this session", "Always allow this server in this project". */
export function approvalLabels(name: string, reason: string | null, programs: string[]): { alwaysLabel: string; projectLabel: string } {
  const what = name.startsWith('mcp__')
    ? programs[0] ?? 'this server'
    : reason
    ? 'this kind of action'
    : name === 'bash' || name === 'terminal_run'
      ? programs.join(', ') || 'this command'
      : 'edits';
  return { alwaysLabel: `Allow ${what} for this session`, projectLabel: `Always allow ${what} in this project` };
}
