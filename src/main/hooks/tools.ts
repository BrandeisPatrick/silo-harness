// Tool names and inputs as Claude Code's hooks see them: where this app's tool is the same thing as one of Claude
// Code's, a hook gets Claude Code's name and input shape, so an existing script works unchanged; the native name
// and arguments always come along as silo_tool_name and silo_tool_input. updatedInput is mapped back.

import path from 'node:path';
import os from 'node:os';
import { judgedCommand } from '../guard';

/** This app's tool → Claude Code's. Tools without a counterpart keep their own name (MCP tools already match). */
export const CLAUDE_TOOL_NAMES: Record<string, string> = {
  bash: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  list_directory: 'LS',
  update_tasks: 'TodoWrite',
  submit_plan: 'ExitPlanMode',
  skill: 'Skill',
  ask_user: 'AskUserQuestion',
};

export function claudeToolName(native: string): string {
  return CLAUDE_TOOL_NAMES[native] ?? native;
}

/**
 * The names a matcher or an `if` rule may use for a tool: Claude Code's, this app's, and for terminal_run (which runs
 * a shell command in the Terminal pane) also Bash, so a Bash policy hook covers it too.
 */
export function toolMatchNames(native: string): string[] {
  const names = [claudeToolName(native)];
  if (!names.includes(native)) names.push(native);
  if (native === 'terminal_run') names.push('Bash');
  return names;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const abs = (cwd: string, p: unknown): string | undefined => (typeof p === 'string' && p ? path.resolve(cwd, p.replace(/^~(?=$|\/)/, os.homedir())) : undefined);

function defined(o: Record<string, unknown>): Record<string, unknown> {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** A tool call's input as Claude Code would have it (paths absolute), or the arguments as they are. */
export function claudeToolInput(native: string, args: unknown, cwd: string): Record<string, unknown> {
  const a = isObj(args) ? args : {};
  switch (native) {
    case 'bash':
      // A call that starts in another folder (path) reads as `cd '<folder>' && <command>`, so a hook sees where it runs
      return defined({ command: judgedCommand(native, a, cwd) ?? a.command, timeout: a.timeout_ms, description: a.description });
    case 'terminal_run':
      return defined({ command: a.command, tab_id: a.tab_id, timeout: a.timeout_ms });
    case 'read_file':
      return defined({ file_path: abs(cwd, a.path), offset: a.offset, limit: a.limit });
    case 'write_file':
      return defined({ file_path: abs(cwd, a.path), content: a.content });
    case 'edit_file':
      return defined({ file_path: abs(cwd, a.path), old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all, edits: a.edits });
    case 'glob':
      return defined({ pattern: a.pattern, path: abs(cwd, a.path) });
    case 'grep':
      return defined({ pattern: a.pattern, path: abs(cwd, a.path), glob: a.include, '-i': a.ignore_case });
    case 'list_directory':
      return defined({ path: abs(cwd, a.path ?? '.') });
    case 'update_tasks':
      return { todos: Array.isArray(a.tasks) ? a.tasks.map((t) => (isObj(t) ? defined({ content: t.title, status: t.status, id: t.id }) : t)) : a.tasks };
    case 'submit_plan':
      return defined({ plan: a.markdown, title: a.title });
    case 'skill':
      return defined({ skill: a.name });
    default:
      return { ...a };
  }
}

/** A hook's updatedInput (Claude Code's shape, or this app's) as the tool's own arguments. */
export function nativeToolInput(native: string, updated: Record<string, unknown>): Record<string, unknown> {
  const u = { ...updated };
  const take = (from: string, to: string) => {
    if (from in u) {
      if (!(to in updated)) u[to] = u[from];
      delete u[from];
    }
  };
  switch (native) {
    case 'bash':
    case 'terminal_run':
      take('timeout', 'timeout_ms');
      break;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      take('file_path', 'path');
      break;
    case 'grep':
      take('glob', 'include');
      take('-i', 'ignore_case');
      break;
    case 'update_tasks':
      if (Array.isArray(u.todos) && !('tasks' in updated)) u.tasks = u.todos.map((t) => (isObj(t) ? defined({ id: t.id, title: t.content ?? t.title, status: t.status }) : t));
      delete u.todos;
      break;
    case 'submit_plan':
      take('plan', 'markdown');
      break;
    case 'skill':
      take('skill', 'name');
      break;
  }
  return u;
}
