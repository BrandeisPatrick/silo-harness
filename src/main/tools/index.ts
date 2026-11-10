import type OpenAI from 'openai';
import type { PermissionMode } from '../../shared/types';
import type { Tool } from './types';
import { GROUP_OF } from './groups';
import { readFile, writeFile, editFile, listDirectory, glob, grep } from './fs';
import { bash } from './shell';
import { browserTools } from './browser';
import { READ_ONLY_BROWSER_TOOLS } from '../browser/policy';
import { skillTool } from './skill';
import { submitPlan } from './plan';
import { terminalTools } from './terminal';
import { createArtifact } from './artifact';
import { updateTasks } from './tasks';
import { askUser } from './ask-user';

export type { Tool, ToolContext, ToolResult, ApprovalResult, ApproveOptions, BrowserApproval } from './types';

/** Plan mode's browser: the tools that read the page or the pane (browser_tabs new is a navigation, with its site card). */
const planBrowserTools = browserTools.filter((t) => READ_ONLY_BROWSER_TOOLS.has(t.name));

/**
 * The tools offered to the model. Plan mode swaps the file-changing tools for submit_plan and keeps only the browser
 * tools that read; ask_user is in every mode.
 */
export function allTools(mode: PermissionMode = 'ask'): Tool[] {
  if (mode === 'plan') return [readFile, listDirectory, glob, grep, bash, skillTool, ...planBrowserTools, ...terminalTools, createArtifact, updateTasks, askUser, submitPlan];
  return [readFile, writeFile, editFile, listDirectory, glob, grep, bash, skillTool, ...browserTools, ...terminalTools, createArtifact, updateTasks, askUser];
}

export function toSpec(tool: Tool): OpenAI.Chat.Completions.ChatCompletionTool {
  const spec: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
  // A group's tool says so where only the native path looks (groups.ts GROUP_OF): not enumerable, never serialised
  if (tool.group) Object.defineProperty(spec, GROUP_OF, { value: tool.group });
  return spec;
}
