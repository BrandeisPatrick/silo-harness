// Tool groups: families of tools a session is offered only once it needs them. Every tool definition is sent with
// every request, and these five took about half of the fixed part of each one (docs/token-bench.md), mostly in
// sessions that never used them. A session starts with the core tools and load_tools, the system prompt names each
// group in one line, and a group stays loaded for the rest of the session once it was loaded (Session.toolGroups): by
// load_tools, by a call to one of its tools by name, or by a user message that clearly needs it. AppConfig.toolSet
// 'all' offers every group from the first request instead. The agent does the loading (Agent.loadGroups).

import type { Tool } from './types';

export const TOOL_GROUPS = ['browser', 'terminal', 'sessions', 'schedules', 'mods'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

/** What each group is for: its line in the system prompt while it is not loaded. */
const GROUP_LINES: Record<ToolGroup, string> = {
  browser: 'open and use web pages in the Browser pane',
  terminal: 'run what keeps running (dev servers, watchers) or what the user should watch, in the Terminal pane',
  sessions: 'start sub-sessions that work in parallel, message, read or merge other sessions, rename this one',
  schedules: 'run a prompt later or on a schedule',
  mods: "write, change and check the app's mods (panels, themes, slash commands)",
};

/** The tool that loads groups. Internal: no tool row, no approval, no hooks; the transcript leaves its calls out. */
export const LOAD_TOOLS = 'load_tools';

export function isToolGroup(v: unknown): v is ToolGroup {
  return typeof v === 'string' && (TOOL_GROUPS as readonly string[]).includes(v);
}

/** The groups in their fixed order, without repeats or names that are not groups. */
export function sortGroups(groups: Iterable<unknown>): ToolGroup[] {
  const set = new Set(groups);
  return TOOL_GROUPS.filter((g) => set.has(g));
}

/** The system prompt's lines for the groups not loaded yet ('' when there are none). */
export function pendingGroupsText(pending: readonly ToolGroup[]): string {
  if (!pending.length) return '';
  const lines = pending.map((g) => `- ${g}: ${GROUP_LINES[g]}`).join('\n');
  return `\nMore tools come in groups. When the task needs one, call ${LOAD_TOOLS} with its name; its tools are yours from the next step on.\n${lines}`;
}

/** load_tools as offered while some groups are not loaded (`pending`). The agent runs its calls itself. */
export function loadToolsTool(pending: readonly ToolGroup[]): Tool {
  return {
    name: LOAD_TOOLS,
    description: 'Load tool groups (listed in the system prompt) so their tools can be called. A group stays loaded for the rest of the session.',
    parameters: {
      type: 'object',
      properties: { groups: { type: 'array', items: { type: 'string', enum: [...pending] } } },
      required: ['groups'],
    },
    readOnly: true,
    async run() {
      return { content: `Error: ${LOAD_TOOLS} is run by the agent itself.` };
    },
  };
}

/** The group names a load_tools call asks for, however the model wrote them (an array, one name, or a list in a string). */
export function requestedGroups(args: unknown): string[] {
  const raw = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>).groups ?? (args as Record<string, unknown>).group : args;
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  return [...new Set(list.filter((g): g is string => typeof g === 'string').map((g) => g.trim().toLowerCase()).filter(Boolean))];
}

/** A web address: http(s), or a local server by host and port. */
const WEB_ADDRESS = /(?:\bhttps?:\/\/|\blocalhost:\d|\b127\.0\.0\.1:\d)/i;
/** "open https://…", "visit localhost:3000": the message asks to open the address itself. */
const OPEN_ADDRESS = /\b(?:open|visit|go to|navigate to)\s+<?(?:https?:\/\/|localhost:\d|127\.0\.0\.1:\d)/i;

/**
 * The groups a user message clearly needs, loaded before the first request so the model does not spend a step on it:
 * the browser, for a web address the message asks to open or names together with the browser. Anything less clear is
 * left to the model (a wrong guess would cost the group's tokens on every later request).
 */
export function groupsForMessage(text: string): ToolGroup[] {
  const t = String(text ?? '');
  if (!WEB_ADDRESS.test(t)) return [];
  return OPEN_ADDRESS.test(t) || /\bbrowser\b/i.test(t) ? ['browser'] : [];
}
