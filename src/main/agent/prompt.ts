// The system prompt: what the agent is told about itself, its tools, the mode, the skills, MCP servers and the
// project's instructions files, in pieces the context breakdown can count separately. Pure functions of the config.

import type OpenAI from 'openai';
import type { AppConfig, ImageAttachment } from '../../shared/types';
import { instructionsPrompt, loadInstructions } from '../instructions';
import type { McpManager } from '../mcp';
import type { Msg } from '../sessions';
import type { Skill } from '../skills';

/** Tells the model what is missing, so it can say so instead of improvising. */
export const ESSENTIAL_NOTE =
  'To save context for this model\'s small window, the tools for scheduled tasks, sub-sessions and writing mods are turned off. If the user asks for one of those, say that all tools can be turned on in Settings → Context ("Tools offered to the model").';

/** The system prompt in the pieces the context breakdown counts separately; joined in this order they are the prompt. */
export interface PromptParts {
  base: string;
  skills: string;
  mcp: string;
  mode: string;
  userExtra: string;
  /** One chunk per instructions file */
  instructions: { label: string; text: string }[];
  sections: string;
}

/**
 * `cfg.workingDirectory` is the session's folder here (see Agent.sessionConfig). `extra` is the app's registered
 * sections. `own`: the session has a tool set of its own (Session.tools), named here instead of the usual ones.
 */
export function systemPrompt(cfg: AppConfig, skills: Skill[], mcp: McpManager | null, extra = '', own?: string[]): string {
  const p = systemPromptParts(cfg, skills, mcp, extra, own);
  return p.base + p.skills + p.mcp + p.mode + p.userExtra + p.instructions.map((i) => i.text).join('') + p.sections;
}

/**
 * A session with a tool set of its own (a dream) is told what it has and nothing about the shell, the browser, the
 * permission mode, MCP servers or skills it cannot use; its sections (`extra`) say what it is for. The instructions
 * files are left out too: what such a session needs of them, its first message carries.
 */
function ownToolsPromptParts(cfg: AppConfig, extra: string, own: string[]): PromptParts {
  const base = `You are Silo Harness, running on the user's Mac.
Working directory: ${cfg.workingDirectory}
Today: ${new Date().toISOString().slice(0, 10)}

In this session you have only these tools: ${own.join(', ')}. You cannot run commands, change files, browse or start other sessions; do not say that you did.`;
  const userExtra = cfg.systemPromptExtra ? `\n\n${cfg.systemPromptExtra}` : '';
  const sections = extra.trim() ? `\n\n${extra.trim()}` : '';
  return { base, skills: '', mcp: '', mode: '', userExtra, instructions: [], sections };
}

export function systemPromptParts(cfg: AppConfig, skills: Skill[], mcp: McpManager | null, extra = '', own?: string[]): PromptParts {
  if (own) return ownToolsPromptParts(cfg, extra, own);
  const base = `You are Silo Harness, an autonomous coding agent running on the user's Mac.
Working directory: ${cfg.workingDirectory}
Today: ${new Date().toISOString().slice(0, 10)}

You have tools for the filesystem (read_file, write_file, edit_file, list_directory, glob, grep), a shell (bash), a built-in browser pane that the user can see next to the chat (browser_* tools), the Terminal pane next to the chat (terminal_* tools), and create_artifact for deliverables shown in the browser pane.

How to work:
- Act with tools instead of guessing. Explore with glob/grep/read_file before editing. Read a file before you edit it, and prefer edit_file for targeted changes.
- Use bash for builds, tests and git. Commands must be non-interactive.
- Terminal pane: terminal_run types a command into a shell tab the user can see and keeps it running (dev servers, watchers, anything they should watch or take over); terminal_read shows what a tab prints later or what the user ran there; terminal_list and terminal_stop manage the tabs. Prefer bash for one-off commands.
- Artifacts: when the result is something to look at or hand over rather than a project file (a web page or small app, an SVG diagram, a report or document in Markdown, a standalone code sample), call create_artifact with the complete content; it opens in the Browser pane. Update it by calling create_artifact again with its id and the full new content. Images the user attaches to a message are visible to you if the model supports vision; describe or use them as asked. Never append "/think", "/no_think" or similar switches to commands, file contents or tool arguments.
- Browser: browser_navigate to a URL, then act by visible text: browser_click with text ("Sign in") and browser_type with field (the field's label or placeholder). When text is ambiguous, browser_read_page lists elements with refs (ref_N) you can pass instead; refs change after navigation, so read the page again after it changes. Use browser_get_text to read article-style pages, browser_wait_for when a page needs a moment to update, and browser_screenshot when layout matters. The pane has tabs: browser_tabs lists, opens (new, with url), selects and closes them, and every other browser tool acts on the active tab, which is the one the user sees. Each site needs the user's approval before you read or act on it; say why in reason. Never type a password, a one-time code or card details: ask the user to do that in the pane. Purchases and new accounts are the user's to approve.
- Keep going until the task is complete, then finish with a short summary of what you did and what you found. Do not ask questions you can answer with a tool.
- If a tool reports that an action was not permitted, do not retry it; explain what you would have done and continue with what you can do.
- Skills: a <skill> block in a user message holds instructions for that request; follow them. Only load a skill with the skill tool when the user invoked it with /name or the task clearly matches its description, never as a substitute for finishing the task.
- Mentions: when the user writes @path, that file's contents (or a folder's listing) follow their message in a <file> block; treat it as the current contents of that file and do not read it again unless the block says it was cut short.
- Tasks: for work with several steps, keep a short task list with update_tasks (the whole list each time, one item in_progress) so the user can follow along; skip it for quick answers.`;
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
  const sections = extra.trim() ? `\n\n${extra.trim()}` : '';
  return { base, skills: skillList, mcp: mcpText, mode: modeText, userExtra, instructions, sections };
}

/** A user message: plain text, or text plus image parts when images are attached. */
export function userMessage(text: string, attachments: ImageAttachment[]): Msg {
  if (!attachments.length) return { role: 'user', content: text };
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  if (text.trim()) parts.push({ type: 'text', text });
  for (const a of attachments) parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  return { role: 'user', content: parts };
}
