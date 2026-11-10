import { findSkill, rescanSkill, supportingFiles, withSkillDir, type Skill } from '../skills';
import type { Tool } from './types';

/** What the skill tool returns for a skill: its body, its folder and files, and any problems with it. */
export function skillToolResult(skill: Skill): string {
  const parts = [`<skill name="${skill.name}">\n${withSkillDir(skill.body, skill.dir)}\n</skill>`];
  const lines = [`Base directory: ${skill.dir}`, 'Relative paths in this skill are relative to that folder.'];
  const { files, total } = supportingFiles(skill);
  if (files.length) lines.push(`Files: ${files.join(', ')}${total > files.length ? ` (and ${total - files.length} more)` : ''}`);
  parts.push(lines.join('\n'));
  if (skill.problems.length) parts.push(`Problems with this skill (see docs/skills.md):\n${skill.problems.map((p) => `- ${p}`).join('\n')}`);
  parts.push("Follow these instructions for the user's request now.");
  return parts.join('\n\n');
}

export const skillTool: Tool = {
  name: 'skill',
  description:
    'Load a skill by name and follow its instructions. Skills are reusable procedures listed in the system prompt. Call this before starting a task that matches a skill. A skill written during this session can be loaded too; the result lists any problems with it.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Skill name exactly as listed' } },
    required: ['name'],
  },
  async run(args, ctx) {
    const name = String(args.name ?? '').trim().replace(/^\//, '');
    let skill = findSkill(ctx.skills, name);
    if (!skill) {
      // A skill written since the list was read: look again once
      skill = rescanSkill(ctx.cwd, name);
      if (skill) ctx.skills.push(skill);
    }
    if (!skill) {
      const available = ctx.skills.filter((s) => s.modelInvocable).map((s) => s.name).join(', ') || '(none)';
      throw new Error(`Unknown skill "${name}". Available skills: ${available}`);
    }
    if (!skill.modelInvocable) {
      const problems = skill.problems.length ? ` Problems: ${skill.problems.join('; ')}.` : ' It has no problems.';
      throw new Error(`"${skill.name}" is run by the user only, with /${skill.name}.${problems}`);
    }
    if (!skill.body) throw new Error(`Skill "${skill.name}" has no instructions. Problems: ${skill.problems.join('; ')}`);
    return { content: skillToolResult(skill) };
  },
};
