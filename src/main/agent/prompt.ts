// The system prompt: what the agent is told about itself, its tools, the mode, the skills, MCP servers and the
// project's instructions files, in pieces the context breakdown can count separately. Pure functions of the config.

import type OpenAI from 'openai';
import type { AppConfig, ImageAttachment } from '../../shared/types';
import { instructionsPrompt, loadInstructions } from '../instructions';
import type { McpManager } from '../mcp';
import type { Msg } from '../sessions';
import type { Skill } from '../skills';
import { BROWSER_RULES, groupsPromptLine, type ToolGroup } from '../tools/groups';

/** Tells the model what is missing, so it can say so instead of improvising. */
export const ESSENTIAL_NOTE =
  'The user chose the essential tools, so the tools for scheduled tasks, sub-sessions and writing mods are turned off. If the user asks for one of those, say that they can be turned on in Settings → Context ("Tools offered to the model").';

/** The app's registered prompt sections: those every session shares, and the session's own (its name, its parent). */
export interface PromptExtra {
  shared: string;
  session: string;
}

/**
 * The system prompt in the pieces the context breakdown counts separately. Joined, they are the prompt in this order:
 * what is the same for every session first (base, sections, skills, MCP servers, the user's extra text), then what is
 * the project's (instructions files), the mode, the environment (working directory, date) and last the session's own
 * sections, so that providers that cache a request's prefix can reuse the start of it across turns and sessions.
 */
export interface PromptParts {
  base: string;
  /** The app's sections every session shares */
  sections: string;
  skills: string;
  mcp: string;
  userExtra: string;
  /** One chunk per instructions file */
  instructions: { label: string; text: string }[];
  mode: string;
  /** The working directory and today's date */
  env: string;
  /** The app's sections for this session alone */
  sessionSections: string;
}

/** The parts joined in prompt order. */
export function joinPrompt(p: PromptParts): string {
  return p.base + p.sections + p.skills + p.mcp + p.userExtra + p.instructions.map((i) => i.text).join('') + p.mode + p.env + p.sessionSections;
}

/**
 * `cfg.workingDirectory` is the session's folder here (see Agent.sessionConfig). `extra` is the app's registered
 * sections. `own`: the session has a tool set of its own (Session.tools), named here instead of the usual ones.
 * `groups`: the tool groups (tools/groups.ts) the session loads when it needs them, loaded yet or not. The prompt then
 * says nothing of what they are for beyond one line naming them, the same all session long: what a group needs the
 * model to know comes with its load, in the conversation. Unset: every group is offered from the start, and the prompt
 * tells of the browser and the Terminal pane itself.
 */
export function systemPrompt(cfg: AppConfig, skills: Skill[], mcp: McpManager | null, extra: string | PromptExtra = '', own?: string[], groups?: readonly ToolGroup[]): string {
  return joinPrompt(systemPromptParts(cfg, skills, mcp, extra, own, groups));
}

const block = (text: string): string => (text.trim() ? `\n\n${text.trim()}` : '');

/** Where the session works and when: near the end of the prompt, since it differs per project and per day. */
function envText(cfg: AppConfig): string {
  return `\n\nWorking directory: ${cfg.workingDirectory}\nToday: ${new Date().toISOString().slice(0, 10)}`;
}

function extraParts(extra: string | PromptExtra): PromptExtra {
  return typeof extra === 'string' ? { shared: extra, session: '' } : extra;
}

/**
 * A session with a tool set of its own (a dream) is told what it has and nothing about the shell, the browser, the
 * permission mode, MCP servers or skills it cannot use; its sections (`extra`) say what it is for. The instructions
 * files are left out too: what such a session needs of them, its first message carries.
 */
function ownToolsPromptParts(cfg: AppConfig, extra: PromptExtra, own: string[]): PromptParts {
  const base = `You are Silo Harness, running on the user's Mac.

In this session you have only these tools: ${own.join(', ')}. You cannot run commands, change files, browse or start other sessions; do not say that you did.`;
  const userExtra = cfg.systemPromptExtra ? `\n\n${cfg.systemPromptExtra}` : '';
  return { base, sections: block(extra.shared), skills: '', mcp: '', userExtra, instructions: [], mode: '', env: envText(cfg), sessionSections: block(extra.session) };
}

export function systemPromptParts(cfg: AppConfig, skills: Skill[], mcp: McpManager | null, extraIn: string | PromptExtra = '', own?: string[], groups?: readonly ToolGroup[]): PromptParts {
  const extra = extraParts(extraIn);
  if (own) return ownToolsPromptParts(cfg, extra, own);
  const upFront = !groups;
  const panes = upFront ? 'the built-in browser pane next to the chat (browser_* tools), the Terminal pane next to the chat (terminal_* tools), ' : '';
  const base = `You are Silo Harness, an autonomous coding agent running on the user's Mac.

You have tools for the filesystem, a shell (bash), ${panes}and create_artifact for deliverables shown in the browser pane.${groupsPromptLine(groups ?? [])}

How to work:
- Act with tools instead of guessing. Explore with glob/grep/read_file before editing. Read a file before you edit it, and prefer edit_file for targeted changes.
- Use bash for builds, tests, git and other one-off commands (non-interactive)${upFront ? '; use terminal_run for what should keep running or the user should watch' : ''}.
- Images the user attaches are visible to you if the model supports vision. Never append "/think", "/no_think" or similar switches to commands, file contents or tool arguments.${upFront ? `\n- ${BROWSER_RULES}` : ''}
- Keep going until the task is complete, then finish with a short summary of what you did and what you found. Do not ask questions you can answer with a tool.
- If a tool reports that an action was not permitted, do not retry it; explain what you would have done and continue with what you can do.
- Skills: a <skill> block in a user message holds instructions for that request; follow them. Only load a skill with the skill tool when the user invoked it with /name or the task clearly matches its description, never as a substitute for finishing the task.
- Mentions: when the user writes @path, that file's contents (or a folder's listing) follow their message in a <file> block; treat it as the current contents of that file and do not read it again unless the block says it was cut short.
- Tasks: for work with several steps, keep a short task list with update_tasks so the user can follow along; skip it for quick answers.`;
  const skillList = skills.length
    ? `\n\nAvailable skills:\n${skills.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n')}`
    : '';
  let modeText = '';
  if (cfg.permissionMode === 'plan') {
    modeText = `\n\nPLAN MODE: you are planning, not building. Explore with read_file, glob, grep, list_directory, read-only shell commands (ls, cat, git status/log/diff …) and the browser. Do not change files and do not run commands that change anything; write_file and edit_file are unavailable. When you understand the task, call submit_plan exactly once with a concise Markdown plan: the goal, numbered steps naming the files to touch, how to verify, and open questions. Then stop; the user decides whether to build it.`;
  } else if (cfg.permissionMode === 'auto') {
    modeText = `\n\nAUTO MODE: actions run without asking the user. A safety check reviews the ones that could do harm (destructive git, deleting outside the working directory, deploys, publishing, sending data out, …). When it blocks one, the result starts with "Blocked by Auto mode" and gives the reason: do not try to get around it with another command, tool or script; continue with other work, or ask the user. sudo and deleting critical folders always ask the user.`;
  }
  const servers = mcp?.describe() ?? '';
  const mcpText = servers
    ? `\n\nMCP servers provide extra tools named mcp__<server>__<tool> (their descriptions say what they do). Use them when they fit the task; the user approves calls that can change something.\n${servers}`
    : '';
  const userExtra = cfg.systemPromptExtra ? `\n\n${cfg.systemPromptExtra}` : '';
  const instructions = loadInstructions(cfg.workingDirectory).map((f) => ({ label: f.label, text: instructionsPrompt([f]) }));
  return { base, sections: block(extra.shared), skills: skillList, mcp: mcpText, userExtra, instructions, mode: modeText, env: envText(cfg), sessionSections: block(extra.session) };
}

/** A user message: plain text, or text plus image parts when images are attached. */
export function userMessage(text: string, attachments: ImageAttachment[]): Msg {
  if (!attachments.length) return { role: 'user', content: text };
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const a of attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  return { role: 'user', content: parts };
}
