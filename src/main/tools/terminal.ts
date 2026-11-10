// The agent's view of the Terminal pane: run a command in a visible shell tab, read what a tab shows,
// list the tabs, interrupt a command. Like Claude Code's terminal tools, this is for work the user should
// be able to watch or take over (servers, watchers, a tab they are already using); bash stays the default.

import type { TerminalTabInfo } from '../../shared/types';
import { describeTabs, tilde, type TerminalManager } from '../terminal';
import type { Tool } from './types';
import { truncate } from './types';

const MAX_TIMEOUT = 120_000;
const DEFAULT_LINES = 100;
const MAX_LINES = 2000;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** The tab a tool acts on: the named one, else the newest open one. */
function resolveTab(tm: TerminalManager, tabId: unknown): TerminalTabInfo {
  if (tabId !== undefined && tabId !== null && String(tabId).trim()) {
    const id = String(tabId).trim();
    const info = tm.get(id);
    if (!info) {
      const open = tm.list().map((t) => t.id);
      throw new Error(`No terminal tab ${id}. ${open.length ? `Open tabs: ${open.join(', ')}.` : 'No tabs are open; terminal_run opens one.'}`);
    }
    return info;
  }
  const info = tm.defaultTab();
  if (!info) throw new Error('No terminal tabs are open. terminal_run opens one.');
  return info;
}

function state(t: TerminalTabInfo): string {
  if (t.exitCode !== undefined) return `shell exited (${t.exitCode})`;
  return t.running ? `running: ${t.running}` : 'idle';
}

export const terminalRun: Tool = {
  name: 'terminal_run',
  group: 'terminal',
  description:
    'Run a command in the Terminal pane the user can see: a shell tab next to the chat that keeps running after this call. Use it for dev servers, watchers and anything the user should watch or take over, or to run in a tab the user is already using; use bash for ordinary builds, tests and git. Returns the output and exit code when the command finishes within timeout_ms (default 15 s), otherwise what it printed so far while it keeps running (then terminal_read shows more).',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to type into the shell' },
      tab_id: { type: 'string', description: 'An open tab from terminal_list, e.g. "tab-2". Omit to open a new tab in the working directory.' },
      timeout_ms: { type: 'integer', description: 'How long to wait for the command to finish, in milliseconds (default 15000, max 120000)' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) throw new Error('command is required');
    const approval = await ctx.approve('terminal_run', command);
    if (!approval.ok) return { content: approval.message };
    const tm = ctx.terminal;
    const tabId = args.tab_id !== undefined && args.tab_id !== null && String(args.tab_id).trim() ? resolveTab(tm, args.tab_id).id : tm.create(undefined, undefined, true, ctx.cwd).id;
    const timeout = clampInt(args.timeout_ms, 1000, MAX_TIMEOUT, 15_000);
    const r = await tm.run(tabId, command, timeout);
    const t = tm.get(tabId);
    const head = `[terminal ${tabId} (${t?.shell ?? 'shell'})]`;
    let tail: string;
    if (t?.exitCode !== undefined) tail = `[the shell exited with code ${t.exitCode}; this tab takes no more commands]`;
    else if (r.finished) tail = `[exit code: ${r.exitCode ?? 'unknown'}]`;
    else if (r.integration) tail = `[still running after ${seconds(r.elapsedMs)} — terminal_read ${tabId} shows what it prints next; terminal_stop ${tabId} interrupts it]`;
    else tail = `[output stopped; exit code unknown (no shell integration for ${t?.shell ?? 'this shell'})]`;
    return { content: truncate(`${head}\n${r.output}${r.output ? '\n' : ''}${tail}`) };
  },
};

export const terminalRead: Tool = {
  name: 'terminal_read',
  group: 'terminal',
  description:
    "Read what a Terminal pane tab shows: the last lines of its screen and scrollback, including commands the user ran there. Use it to see later output of a command terminal_run left running, or when the user refers to something in their terminal.",
  parameters: {
    type: 'object',
    properties: {
      tab_id: { type: 'string', description: 'The tab to read (from terminal_list). Omit for the newest open tab.' },
      lines: { type: 'integer', description: `How many lines from the bottom (default ${DEFAULT_LINES}, max ${MAX_LINES})` },
      wait_ms: { type: 'integer', description: 'Wait up to this long for new output before reading, e.g. after starting a server (max 60000)' },
    },
  },
  async run(args, ctx) {
    const tm = ctx.terminal;
    const tab = resolveTab(tm, args.tab_id);
    const lines = clampInt(args.lines, 1, MAX_LINES, DEFAULT_LINES);
    const wait = clampInt(args.wait_ms, 0, 60_000, 0);
    const text = await tm.read(tab.id, lines, wait);
    const t = tm.get(tab.id) ?? tab;
    return { content: truncate(`[terminal ${t.id} (${t.shell}) · ${state(t)} · cwd ${tilde(t.cwd)}]\n${text || '(the screen is empty)'}`) };
  },
};

export const terminalList: Tool = {
  name: 'terminal_list',
  group: 'terminal',
  description: 'List the Terminal pane tabs: id, title, whether a command is running, and the current directory.',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    return { content: describeTabs(ctx.terminal.list()) };
  },
};

export const terminalStop: Tool = {
  name: 'terminal_stop',
  group: 'terminal',
  description: 'Interrupt the command running in a Terminal pane tab (sends Ctrl-C). The tab and its shell stay open.',
  parameters: {
    type: 'object',
    properties: { tab_id: { type: 'string', description: 'The tab whose command to interrupt (from terminal_list)' } },
    required: ['tab_id'],
  },
  async run(args, ctx) {
    const tab = resolveTab(ctx.terminal, args.tab_id);
    const running = ctx.terminal.interrupt(tab.id);
    return { content: `Sent Ctrl-C to ${tab.id}${running ? ` (${running})` : ''}.` };
  },
};

export const terminalTools: Tool[] = [terminalRun, terminalRead, terminalList, terminalStop];
